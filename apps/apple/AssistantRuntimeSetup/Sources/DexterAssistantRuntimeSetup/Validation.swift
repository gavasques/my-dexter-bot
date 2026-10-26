import Foundation
#if os(macOS)
import Darwin
import Security

public struct OfficialMacArtifactValidator: ArtifactValidating {
    public init() {}
    public func materializeAndValidate(_ artifact: OfficialArtifact, downloaded: URL, stage: URL,
                                       requirements: RuntimeRequirements) async throws -> RuntimeSetupResult {
        try OfficialSourcePolicy.validate(artifact)
        guard try fileDigest(downloaded) == artifact.sha256 else { throw SetupError.checksumMismatch }
        let command = stage.appendingPathComponent(artifact.provider.rawValue)
        let scratch = try scratchDirectory(); defer { try? FileManager.default.removeItem(at: scratch) }
        switch artifact.format {
        case .executable: try copyExclusive(downloaded, to: command)
        case .singleExecutableTarGzip:
            guard let entry = artifact.archiveEntry else { throw SetupError.unsafeArchive }
            let listing = try await BoundedProcess().run(URL(fileURLWithPath: "/usr/bin/tar"),
                arguments: ["-tzf", downloaded.path], scratch: scratch, maximumBytes: 16384)
            let verbose = try await BoundedProcess().run(URL(fileURLWithPath: "/usr/bin/tar"),
                arguments: ["-tvzf", downloaded.path], scratch: scratch, maximumBytes: 16384)
            try validateSingleArchiveEntry(listing: listing.stdout, verbose: verbose.stdout, expected: entry,
                                           listingStatus: listing.status, verboseStatus: verbose.status)
            // Stream precisely one regular member to a newly created file. tar never extracts a pathname/link.
            try await extractSingleMember(archive: downloaded, entry: entry, destination: command, scratch: scratch)
        }
        let directory = try LocalSetupStore.openDirectory(stage.path, create: false)
        let commandFD = openat(directory, artifact.provider.rawValue, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        close(directory)
        guard commandFD >= 0 else { throw SetupError.unsafePath }
        let permissionResult = fchmod(commandFD, 0o700); close(commandFD)
        guard permissionResult == 0 else { throw SetupError.storageFailure }
        try validateMachO(command, architecture: artifact.architecture)
        try validateVendorSignature(command, provider: artifact.provider)
        let assessment = try await BoundedProcess().run(URL(fileURLWithPath: "/usr/sbin/spctl"),
            arguments: ["--assess", "--type", "execute", "--ignore-cache", "--no-cache", command.path], scratch: scratch, seconds: 30)
        guard assessment.status == 0 else { throw SetupError.notarizationRejected }
        let candidate = await LocalRuntimeMetadataInspector().inspect(command: command.path, provider: artifact.provider, requirements: requirements)
        guard candidate.version == artifact.version else { throw SetupError.versionMismatch }
        guard candidate.state == .compatible, let hash = candidate.sha256 else { throw candidate.error ?? SetupError.incompatible }
        return RuntimeSetupResult(command: command.path, version: artifact.version, sha256: hash, capabilities: candidate.capabilities)
    }
}
func validateSingleArchiveEntry(listing: Data, verbose: Data, expected: String, listingStatus: Int32 = 0, verboseStatus: Int32 = 0) throws {
    guard listingStatus == 0, verboseStatus == 0,
          String(data: listing, encoding: .utf8)?.split(whereSeparator: \.isNewline).map(String.init) == [expected],
          let lines = String(data: verbose, encoding: .utf8)?.split(whereSeparator: \.isNewline), lines.count == 1,
          lines[0].hasPrefix("-"), lines[0].hasSuffix(" " + expected),
          !expected.contains("/"), !expected.contains(".."), !expected.hasPrefix("-") else { throw SetupError.unsafeArchive }
}
func extractSingleMember(archive: URL, entry: String, destination: URL, scratch: URL) async throws {
    let child = Task.detached {
        let parent = try LocalSetupStore.openDirectory(destination.deletingLastPathComponent().path, create: false)
        let fd = openat(parent, destination.lastPathComponent, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        close(parent)
        guard fd >= 0 else { throw SetupError.unsafePath }; defer { close(fd) }
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-xOzf", archive.path, "--", entry]; process.currentDirectoryURL = scratch
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": scratch.path, "LANG": "en_US.UTF-8"]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw SetupError.unsafeArchive }
        let deadline = Date().addingTimeInterval(60); var failure: SetupError?
        while process.isRunning {
            var status = stat(); guard fstat(fd, &status) == 0 else { failure = .storageFailure; break }
            if status.st_size > 768 * 1024 * 1024 { failure = .oversized; break }
            if Date() > deadline { failure = .timedOut; break }
            if Task.isCancelled { failure = .cancelled; break }
            do { try await Task.sleep(for: .milliseconds(20)) } catch { failure = .cancelled; break }
        }
        if failure != nil && process.isRunning {
            process.terminate(); usleep(50_000); if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        process.waitUntilExit(); if let failure { throw failure }
        guard process.terminationStatus == 0, fsync(fd) == 0 else { throw SetupError.unsafeArchive }
    }
    try await withTaskCancellationHandler { try await child.value } onCancel: { child.cancel() }
}
func copyExclusive(_ source: URL, to destination: URL) throws {
    let directory = try LocalSetupStore.openDirectory(destination.deletingLastPathComponent().path, create: false); defer { close(directory) }
    guard source.deletingLastPathComponent().path == destination.deletingLastPathComponent().path else { throw SetupError.unsafePath }
    let input = openat(directory, source.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard input >= 0 else { throw SetupError.unsafePath }; defer { close(input) }
    let output = openat(directory, destination.lastPathComponent, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard output >= 0 else { throw SetupError.unsafePath }; defer { close(output) }
    let reader = FileHandle(fileDescriptor: input, closeOnDealloc: false); let writer = FileHandle(fileDescriptor: output, closeOnDealloc: false)
    var bytes = 0
    while let data = try reader.read(upToCount: 1024 * 1024), !data.isEmpty {
        bytes += data.count; guard bytes <= 768 * 1024 * 1024 else { throw SetupError.oversized }; try writer.write(contentsOf: data)
    }
    guard fsync(output) == 0 else { throw SetupError.storageFailure }
}
func validateMachO(_ url: URL, architecture: String) throws {
    _ = try binaryIdentity(url)
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    guard let header = try handle.read(upToCount: 32), header.count == 32 else { throw SetupError.wrongArchitecture }
    let bytes = Array(header)
    func u32(_ offset: Int) -> UInt32 { UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24 }
    guard u32(0) == 0xfeedfacf, u32(12) == 2,
          u32(4) == (architecture == "arm64" ? 0x0100000c : 0x01000007) else { throw SetupError.wrongArchitecture }
}
func validateVendorSignature(_ url: URL, provider: AssistantProvider) throws {
    let team = provider == .claude ? "Q6L2SF6YDW" : "2DC432GLL2"
    let identifier = provider == .claude ? "com.anthropic.claude-code" : "codex"
    let requirementText = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier)\""
    var requirement: SecRequirement?; var code: SecStaticCode?
    guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
          SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code, let requirement,
          SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw SetupError.signatureRejected }
}
#endif
