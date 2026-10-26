import Foundation
#if os(macOS)
import Darwin
import Security

struct FileIdentity: Equatable, Sendable {
    let device: Int32; let inode: UInt64; let bytes: Int64; let modified: Int64; let nanoseconds: Int64
    init(_ status: stat) { device = status.st_dev; inode = status.st_ino; bytes = status.st_size
        modified = Int64(status.st_mtimespec.tv_sec); nanoseconds = Int64(status.st_mtimespec.tv_nsec) }
}
func binaryIdentity(_ url: URL, maximumBytes: Int64 = 1024 * 1024 * 1024) throws -> FileIdentity {
    var status = stat()
    guard lstat(url.path, &status) == 0, status.st_mode & S_IFMT == S_IFREG,
          status.st_uid == getuid() || status.st_uid == 0,
          status.st_mode & 0o022 == 0, status.st_size > 0, status.st_size <= maximumBytes else { throw SetupError.unsafePath }
    return FileIdentity(status)
}
func fileDigest(_ url: URL, maximumBytes: Int64 = 1024 * 1024 * 1024) throws -> String {
    let before = try binaryIdentity(url, maximumBytes: maximumBytes)
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw SetupError.unsafePath }; defer { close(fd) }
    var status = stat(); guard fstat(fd, &status) == 0, FileIdentity(status) == before else { throw SetupError.artifactChanged }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    var hash = CryptoKit.SHA256(); var total: Int64 = 0
    while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
        total += Int64(chunk.count); guard total <= maximumBytes else { throw SetupError.oversized }; hash.update(data: chunk)
    }
    guard total == before.bytes, try binaryIdentity(url, maximumBytes: maximumBytes) == before else { throw SetupError.artifactChanged }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
import CryptoKit

struct ProbeOutput: Sendable { let status: Int32; let stdout: Data; let stderr: Data }
/// Only fixed metadata/Apple-tool operations call this. No shell, user environment or inherited credentials.
struct BoundedProcess: Sendable {
    func run(_ executable: URL, arguments: [String], scratch: URL, maximumBytes: Int = 2 * 1024 * 1024,
             seconds: Double = 12) async throws -> ProbeOutput {
        let child = Task.detached {
            let process = Process(); process.executableURL = executable; process.arguments = arguments
            process.currentDirectoryURL = scratch
            process.environment = ["HOME": scratch.path, "TMPDIR": scratch.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                                   "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8", "DISABLE_UPDATES": "1",
                                   "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"]
            let output = scratch.appendingPathComponent("stdout-" + UUID().uuidString)
            let error = scratch.appendingPathComponent("stderr-" + UUID().uuidString)
            guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]),
                  FileManager.default.createFile(atPath: error.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw SetupError.storageFailure }
            let stdout = try FileHandle(forWritingTo: output); let stderr = try FileHandle(forWritingTo: error)
            defer { try? stdout.close(); try? stderr.close(); try? FileManager.default.removeItem(at: output); try? FileManager.default.removeItem(at: error) }
            process.standardInput = FileHandle.nullDevice; process.standardOutput = stdout; process.standardError = stderr
            do { try process.run() } catch { throw SetupError.downloadFailed }
            let deadline = Date().addingTimeInterval(seconds)
            var failure: SetupError?
            func outputSizes() throws -> (Int64, Int64) {
                var out = stat(), err = stat()
                guard fstat(stdout.fileDescriptor, &out) == 0, fstat(stderr.fileDescriptor, &err) == 0,
                      out.st_size >= 0, err.st_size >= 0 else { throw SetupError.storageFailure }
                return (out.st_size, err.st_size)
            }
            while process.isRunning {
                if Task.isCancelled { failure = .cancelled; break }
                if Date() > deadline { failure = .timedOut; break }
                do {
                    let (a, b) = try outputSizes()
                    if a + b > Int64(maximumBytes) { failure = .oversized; break }
                } catch { failure = .storageFailure; break }
                do { try await Task.sleep(for: .milliseconds(25)) } catch { failure = .cancelled; break }
            }
            if let failure {
                if process.isRunning { process.terminate() }
                let stopDeadline = Date().addingTimeInterval(0.5)
                while process.isRunning && Date() < stopDeadline { usleep(10_000) }
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit(); throw failure
            }
            process.waitUntilExit()
            let (a, b) = try outputSizes()
            guard a + b <= Int64(maximumBytes) else { throw SetupError.oversized }
            func readBounded(_ url: URL, count: Int) throws -> Data {
                let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
                return try handle.read(upToCount: count + 1) ?? Data()
            }
            let out = try readBounded(output, count: maximumBytes)
            let err = try readBounded(error, count: max(0, maximumBytes - out.count))
            guard out.count + err.count <= maximumBytes else { throw SetupError.oversized }
            return ProbeOutput(status: process.terminationStatus, stdout: out, stderr: err)
        }
        return try await withTaskCancellationHandler { try await child.value } onCancel: { child.cancel() }
    }
}
func scratchDirectory() throws -> URL {
    guard let pointer = realpath(FileManager.default.temporaryDirectory.path, nil) else { throw SetupError.unsafePath }
    let temporary = String(cString: pointer); free(pointer)
    let url = URL(fileURLWithPath: temporary).appendingPathComponent("dexter-assistant-metadata-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    return url
}
func extractVersion(_ output: Data) -> String? {
    guard let text = String(data: output, encoding: .utf8), text.utf8.count < 16384,
          let match = text.range(of: #"(?<![0-9])[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?"#, options: .regularExpression) else { return nil }
    let version = String(text[match]); return validVersion(version) ? version : nil
}
public struct LocalRuntimeMetadataInspector: RuntimeMetadataInspecting {
    public init() {}
    public func inspect(command: String, provider: AssistantProvider, requirements: RuntimeRequirements) async -> RuntimeCandidate {
        guard command.hasPrefix("/"), !command.contains("\0") else { return RuntimeCandidate(command: command, state: .failed, error: .unsafePath) }
        guard FileManager.default.fileExists(atPath: command) else { return RuntimeCandidate(command: command, state: .missing) }
        // Foundation rewrites /private/var to /var on macOS. The host pins POSIX realpath, so use
        // that same identity here: otherwise a valid receipt fails the host's exact-path comparison.
        guard let resolved = realpath(command, nil) else { return RuntimeCandidate(command: command, state: .failed, error: .unsafePath) }
        let executable = URL(fileURLWithPath: String(cString: resolved)); free(resolved)
        var version: String?; var hash: String?
        do {
            let before = try binaryIdentity(executable)
            guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw SetupError.unsafePath }
            hash = try fileDigest(executable)
            let scratch = try scratchDirectory(); defer { try? FileManager.default.removeItem(at: scratch) }
            let output = try await BoundedProcess().run(executable, arguments: ["--version"], scratch: scratch, maximumBytes: 16384)
            guard output.status == 0, let parsed = extractVersion(output.stdout) else { throw SetupError.versionMismatch }; version = parsed
            let capabilities = try await metadataCapabilities(executable, provider: provider, scratch: scratch)
            guard try binaryIdentity(executable) == before, try fileDigest(executable) == hash else { throw SetupError.artifactChanged }
            return RuntimeCandidate(command: command, resolvedCommand: executable.path, sha256: hash, version: version,
                state: capabilities.satisfies(requirements) ? .compatible : .needsUpdate, capabilities: capabilities)
        } catch {
            return RuntimeCandidate(command: command, resolvedCommand: executable.path, sha256: hash, version: version,
                state: error as? SetupError == .timedOut || error as? SetupError == .versionMismatch ? .unknown :
                    (version != nil && error as? SetupError == .incompatible ? .needsUpdate : .failed), error: error as? SetupError ?? .storageFailure)
        }
    }
}
let claudeRequiredFlags = ["--input-format", "--output-format", "--verbose", "--include-partial-messages", "--tools",
    "--strict-mcp-config", "--permission-mode", "--setting-sources", "--settings", "--disable-slash-commands", "--no-chrome",
    "--session-id", "--resume", "--mcp-config", "--allowedTools"]
func metadataCapabilities(_ executable: URL, provider: AssistantProvider, scratch: URL) async throws -> RuntimeCapabilities {
    switch provider {
    case .claude:
        let output = try await BoundedProcess().run(executable, arguments: ["--help"], scratch: scratch, maximumBytes: 256 * 1024)
        guard output.status == 0, let help = String(data: output.stdout, encoding: .utf8) else { throw SetupError.incompatible }
        return RuntimeCapabilities(text: claudeRequiredFlags.allSatisfy { flag in
            help.range(of: NSRegularExpression.escapedPattern(for: flag) + #"(?=[\s,=<\[])"#, options: .regularExpression) != nil
        })
    case .codex:
        let schema = scratch.appendingPathComponent("schema", isDirectory: true)
        let output = try await BoundedProcess().run(executable,
            arguments: ["app-server", "generate-json-schema", "--experimental", "--out", schema.path], scratch: scratch, seconds: 20)
        guard output.status == 0 else { throw SetupError.incompatible }
        return try codexCapabilities(schema: schema)
    }
}
func codexCapabilities(schema: URL) throws -> RuntimeCapabilities {
    let root = schema.resolvingSymlinksInPath()
    guard let iterator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey, .fileSizeKey, .isRegularFileKey]) else { throw SetupError.incompatible }
    var bytes = 0; var entries = 0
    for case let url as URL in iterator {
        entries += 1; let value = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .fileSizeKey, .isRegularFileKey])
        guard value.isSymbolicLink != true, entries <= 4096 else { throw SetupError.unsafePath }
        bytes += value.fileSize ?? 0; guard bytes <= 64 * 1024 * 1024 else { throw SetupError.oversized }
    }
    func read(_ relative: String) throws -> Data {
        let url = root.appendingPathComponent(relative)
        _ = try binaryIdentity(url, maximumBytes: 4 * 1024 * 1024)
        return try Data(contentsOf: url)
    }
    let requests = try read("ClientRequest.json")
    guard let requestObject = try JSONSerialization.jsonObject(with: requests) as? [String: Any],
          let variants = requestObject["oneOf"] as? [[String: Any]] else { throw SetupError.incompatible }
    let methods = variants.compactMap { variant -> String? in
        let props = variant["properties"] as? [String: Any]; let method = props?["method"] as? [String: Any]
        return method?["const"] as? String ?? (method?["enum"] as? [String])?.first
    }
    let text = ["thread/start", "thread/resume", "turn/start", "turn/interrupt"].allSatisfy(methods.contains)
    var voice = false; var voices: [String] = []
    if ["thread/realtime/start", "thread/realtime/stop", "thread/realtime/appendText", "thread/realtime/appendSpeech"].allSatisfy(methods.contains),
       String(data: requests, encoding: .utf8)?.contains("experimentalApi") == true,
       let startData = try? read("v2/ThreadRealtimeStartParams.json"),
       let start = try JSONSerialization.jsonObject(with: startData) as? [String: Any],
       let definitions = start["definitions"] as? [String: Any], let props = start["properties"] as? [String: Any],
       ["threadId", "clientManagedHandoffs", "transport", "initialItems", "voice"].allSatisfy({ props[$0] != nil }),
       let versionDef = definitions["RealtimeConversationVersion"] as? [String: Any],
       (versionDef["enum"] as? [String])?.contains("v3") == true,
       let transport = definitions["ThreadRealtimeStartTransport"],
       String(data: try JSONSerialization.data(withJSONObject: transport), encoding: .utf8)?.contains("webrtc") == true,
       let voiceDef = definitions["RealtimeVoice"] as? [String: Any], let values = voiceDef["enum"] as? [String],
       !values.isEmpty, values.count <= 64, values.allSatisfy({ $0.range(of: "^[a-z][a-z0-9_-]{0,63}$", options: .regularExpression) != nil }) {
        let notifications = ["ThreadRealtimeSdpNotification", "ThreadRealtimeStartedNotification", "ThreadRealtimeTranscriptDoneNotification",
                             "ThreadRealtimeItemAddedNotification", "ThreadRealtimeClosedNotification"]
        voice = notifications.allSatisfy { (try? read("v2/" + $0 + ".json")) != nil }
        if voice { voices = values }
    }
    return RuntimeCapabilities(text: text, nativeVoice: voice, voices: voices)
}
#else
public struct LocalRuntimeMetadataInspector: RuntimeMetadataInspecting {
    public init() {}
    public func inspect(command: String, provider: AssistantProvider, requirements: RuntimeRequirements) async -> RuntimeCandidate {
        RuntimeCandidate(command: command, state: .unavailable, error: .unavailable)
    }
}
#endif
