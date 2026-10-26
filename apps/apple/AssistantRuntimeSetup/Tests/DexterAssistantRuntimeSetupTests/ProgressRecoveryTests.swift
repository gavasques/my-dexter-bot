import Foundation
import Testing
@testable import DexterAssistantRuntimeSetup
#if os(macOS)
import Darwin

actor SetupProgressRecorder {
    var steps: [RuntimeSetupStep] = []
    func append(_ step: RuntimeSetupStep) { steps.append(step) }
}

@Test func preparationStopsAtFirstCompatibleCandidateWithoutProbingOtherPrograms() async throws {
    let f = try Fixture(); defer { f.cleanup() }
    let first = f.base.appendingPathComponent("claude")
    try f.bytes.write(to: first)
    let inspector = SpyInspector([first.path: .init(command: first.path, resolvedCommand: first.path, sha256: digest(f.bytes),
        version: "2.1.300", state: .compatible, capabilities: .init(text: true))])
    let resolver = SpyResolver(f.artifact)
    let runtime = AssistantRuntimeSetup(configuration: f.config, inspector: inspector, resolver: resolver,
        downloader: SpyDownloader(f.bytes), validator: SyntheticValidator(), candidates: [.claude: [first.path, "/synthetic/other/claude"]])
    let steps = SetupProgressRecorder()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude, progress: { await steps.append($0) })
    #expect(plan.action == .reuse); #expect(await inspector.calls == 1); #expect(await resolver.calls == 0)
    #expect(await steps.steps == [.inspecting])
}

@Test func versionedClaudeSymlinkPreparesReusesAndReconcilesWithoutDownload() async throws {
    let f = try Fixture(); defer { f.cleanup() }
    let version = f.base.appendingPathComponent("2.1.300"), launcher = f.base.appendingPathComponent("claude")
    let flags = claudeRequiredFlags.joined(separator: " ") + " "
    let bytes = Data(("#!/bin/sh\ncase \"$1\" in --version) printf '2.1.300 (synthetic)\\n';; --help) printf '%s\\n' '\(flags)';; *) exit 90;; esac\n").utf8)
    try bytes.write(to: version); _ = chmod(version.path, 0o700)
    try FileManager.default.createSymbolicLink(at: launcher, withDestinationURL: version)
    let downloader = SpyDownloader(f.bytes), resolver = SpyResolver(f.artifact)
    let runtime = AssistantRuntimeSetup(configuration: f.config, inspector: LocalRuntimeMetadataInspector(), resolver: resolver,
        downloader: downloader, validator: SyntheticValidator(), candidates: [.claude: [launcher.path]])
    let steps = SetupProgressRecorder()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    #expect(plan.reuseCandidate?.command == launcher.path)
    #expect(plan.reuseCandidate?.resolvedCommand == version.path)
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture }, progress: { await steps.append($0) })
    #expect(receipt.state == .committed); #expect(receipt.result?.command == version.path)
    #expect(try await runtime.reconcile(requestID: receipt.requestID, requestHash: receipt.requestHash) == receipt)
    #expect(await resolver.calls == 0); #expect(await downloader.calls == 0)
    #expect(await steps.steps == [.reusing])
}

@Test func downloadProgressIsTruthfulAndReplayOnlyReconciles() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let downloader = SpyDownloader(f.bytes), runtime = f.runtime(downloader: downloader)
    let steps = SetupProgressRecorder()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude, progress: { await steps.append($0) })
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture }, progress: { await steps.append($0) })
    #expect(receipt.state == .committed)
    #expect(await steps.steps == [.inspecting, .resolvingRelease, .downloading, .verifying, .committing])
    let replay = SetupProgressRecorder()
    #expect(try await runtime.install(plan: plan, currentCapture: { f.capture }, progress: { await replay.append($0) }) == receipt)
    #expect(await replay.steps == [.reconciling]); #expect(await downloader.calls == 1)
}

@Test func cancelledProgressCallbackCannotAuthorizeCommit() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture }, progress: { step in
        if step == .committing { await runtime.cancel(requestID: f.capture.requestID) }
    })
    #expect(receipt.state == .cancelled)
    #expect(try FileManager.default.contentsOfDirectory(atPath: f.config.managedRoot.path).allSatisfy { !$0.hasPrefix("claude-") })
}

@Test func boundedProbeTerminatesOnlyItsOwnNonCooperativeSyntheticProcess() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let file = f.base.appendingPathComponent("synthetic-stuck-probe")
    try Data("#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n".utf8).write(to: file); _ = chmod(file.path, 0o700)
    let start = ContinuousClock.now
    await #expect(throws: SetupError.timedOut) {
        _ = try await BoundedProcess().run(file, arguments: ["--help"], scratch: f.base, seconds: 0.05)
    }
    #expect(start.duration(to: .now) < .seconds(3))
}

@Test func cancellationBeforeAdmissionIsDurableAndCannotExecuteOnReplay() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime()
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let task = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        return try await runtime.install(plan: plan, currentCapture: { f.capture })
    }
    let receipt = try await task.value
    #expect(receipt.state == .cancelled); #expect(receipt.error == .cancelled)
    #expect(try await runtime.reconcile(requestID: f.capture.requestID, requestHash: plan.requestHash) == receipt)
    let reopened = f.runtime()
    #expect(try await reopened.install(plan: plan, currentCapture: { f.capture }) == receipt)
}

@Test func busyBeforeAdmissionCanRetryExactPlanWithoutInventingUnknownReceipt() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let downloader = SpyDownloader(f.bytes), runtime = f.runtime(downloader: downloader)
    let plan = try await runtime.prepare(capture: f.capture, provider: .claude)
    let lock = try LocalSetupStore(root: f.config.managedRoot, create: true)
    try lock.lock()
    await #expect(throws: SetupError.busy) { try await runtime.install(plan: plan, currentCapture: { f.capture }) }
    #expect(try await runtime.reconcile(requestID: f.capture.requestID, requestHash: plan.requestHash) == nil)
    lock.unlock()
    let receipt = try await runtime.install(plan: plan, currentCapture: { f.capture })
    #expect(receipt.state == .committed); #expect(receipt.requestID == plan.capture.requestID)
    #expect(receipt.requestHash == plan.requestHash); #expect(await downloader.calls == 1)
}

@Test func recoveryDoesNotHidePendingRequestBehindMoreThan256TerminalJournals() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let runtime = f.runtime()
    let store = try LocalSetupStore(root: f.config.managedRoot, create: true)
    let ids = (0..<257).map { "index-test-\($0)" }.sorted { store.journalName($0) < store.journalName($1) }
    for (index, id) in ids.enumerated() {
        let capture = SetupCapture(hostID: f.capture.hostID, bundleID: f.capture.bundleID,
            selectionGeneration: f.capture.selectionGeneration, windowID: f.capture.windowID, requestID: id)
        let plan = try SetupPlan(capture: capture, provider: .claude, requirements: .init(), reuseCandidate: nil, artifact: f.artifact)
        try store.writeJournal(Journal(plan: plan, receipt: .init(requestID: id, requestHash: plan.requestHash,
            state: index == 256 ? .preparing : .cancelled), versionDirectory: store.versionName(f.artifact)))
    }
    let pending = try await runtime.recoverableReceipts(provider: .claude)
    #expect(pending.count == 1); #expect(pending.first?.requestID == ids.last); #expect(pending.first?.state == .unknown)
}

@Test func probeOutputIsBoundedBeforeReadingFilesIntoMemory() async throws {
    let f = try Fixture(); defer { f.cleanup() }; let file = f.base.appendingPathComponent("synthetic-output")
    try Data("#!/bin/sh\ni=0\nwhile [ \"$i\" -lt 2048 ]; do printf '01234567890123456789012345678901'; i=$((i+1)); done\n".utf8).write(to: file)
    _ = chmod(file.path, 0o700)
    await #expect(throws: SetupError.oversized) {
        _ = try await BoundedProcess().run(file, arguments: [], scratch: f.base, maximumBytes: 256)
    }
}
#endif
