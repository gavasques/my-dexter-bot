#if os(macOS)
import Darwin
import Foundation
import Security

public enum LocalMacAgentIdentityBlockReason: String, Codable, Sendable { case unsafeConfiguration, conflict, locked, signingIdentityUnavailable, nonExportabilityUnconfirmed, unavailable, protocolError, timedOut, cancelled }
public enum LocalMacAgentIdentityLoadResult: Equatable, Sendable {
    case usable(fingerprint: String)
    case missing
    case blocked(LocalMacAgentIdentityBlockReason)
}
extension LocalMacAgentSetup {
    /// Read-only helper operation. Missing is returned only when both qualified key/certificate are absent.
    /// Partial, locked, unsigned, software-policy and unknown state never authorize provisioning.
    public static func loadIdentity(location: LocalMacAgentSetupLocation, selection: LocalMacAgentSelection,
                                    expectedInstallationID: String) async -> LocalMacAgentIdentityLoadResult {
        await loadIdentity(location: location, selection: selection, expectedInstallationID: expectedInstallationID,
                           invoke: { helper, config in try await runLoadOnlyHelper(helper, configuration: config) })
    }
    static func loadIdentity(location: LocalMacAgentSetupLocation, selection: LocalMacAgentSelection,
                             expectedInstallationID: String,
                             invoke: @Sendable (URL, URL) async throws -> Data) async -> LocalMacAgentIdentityLoadResult {
        do {
            guard selection.configurationURL == location.configuration else { return .blocked(.unsafeConfiguration) }
            let before = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: expectedInstallationID)
            let config = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384)) as? [String: Any]
            guard let client = config?["client"] as? [String: Any], let executable = client["executable"] as? String,
                  [location.helper.path, location.boundHelper.path].contains(executable) else { return .blocked(.unsafeConfiguration) }
            try Task.checkCancellation()
            let bytes = try await invoke(URL(fileURLWithPath: executable), location.helperConfiguration)
            try Task.checkCancellation()
            guard try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: expectedInstallationID) == before else { return .blocked(.conflict) }
            let reply = try parseIdentityLoadReply(bytes)
            let record = location.dataDirectory.appendingPathComponent("native-device.json")
            var status = stat()
            let recorded: String?
            if lstat(record.path, &status) == 0 {
                let object = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(record, maximum: 16384)) as? [String: Any]
                guard Set(object?.keys.map { $0 } ?? []) == ["fingerprint"], let fingerprint = object?["fingerprint"] as? String,
                      matches(fingerprint, "^[a-f0-9]{64}$") else { return .blocked(.conflict) }; recorded = fingerprint
            } else { guard errno == ENOENT else { return .blocked(.unsafeConfiguration) }; recorded = nil }
            switch reply {
            case .usable(let fingerprint): if let recorded, recorded != fingerprint { return .blocked(.conflict) }
            case .missing:
                if recorded != nil || FileManager.default.fileExists(atPath: location.dataDirectory.appendingPathComponent("binding.json").path) { return .blocked(.conflict) }
            case .blocked: break
            }
            return reply
        } catch is CancellationError { return .blocked(.cancelled) }
        catch let error as LocalMacAgentIdentityBlockReason { return .blocked(error) }
        catch { return .blocked(.unsafeConfiguration) }
    }
    static func parseIdentityLoadReply(_ bytes: Data) throws -> LocalMacAgentIdentityLoadResult {
        guard !bytes.isEmpty, bytes.count <= 65536,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let ok = object["ok"] as? Bool else { throw LocalMacAgentIdentityBlockReason.protocolError }
        if !ok {
            guard Set(object.keys) == ["ok", "error"], let reason = object["error"] as? String else { throw LocalMacAgentIdentityBlockReason.protocolError }
            if reason == "missing" { return .missing }
            switch reason {
            case "conflict": return .blocked(.conflict)
            case "locked": return .blocked(.locked)
            case "signingIdentityUnavailable": return .blocked(.signingIdentityUnavailable)
            case "nonExportabilityUnconfirmed": return .blocked(.nonExportabilityUnconfirmed)
            default: return .blocked(.unavailable)
            }
        }
        guard Set(object.keys) == ["ok", "fingerprint", "certificateDER", "policy"],
              object["policy"] as? String == productionPolicy else { return .blocked(.nonExportabilityUnconfirmed) }
        guard let fingerprint = object["fingerprint"] as? String, matches(fingerprint, "^[a-f0-9]{64}$"),
              let encoded = object["certificateDER"] as? String, let der = Data(base64Encoded: encoded),
              encoded == der.base64EncodedString(), der.count <= 16384,
              SecCertificateCreateWithData(nil, der as CFData) != nil, sha256Hex(der) == fingerprint else { return .blocked(.protocolError) }
        return .usable(fingerprint: fingerprint)
    }
    private static func runLoadOnlyHelper(_ helper: URL, configuration: URL) async throws -> Data {
        let child = Task.detached(priority: .userInitiated) {
            let process = Process(), input = Pipe(), output = Pipe()
            process.executableURL = helper; process.arguments = ["--config", configuration.path]
            process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
            process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { throw LocalMacAgentIdentityBlockReason.unavailable }
            defer { if process.isRunning { process.terminate(); usleep(50_000); if process.isRunning { kill(process.processIdentifier, SIGKILL) }; process.waitUntilExit() } }
            try input.fileHandleForWriting.write(contentsOf: Data(#"{"operation":"load"}"#.utf8)); try input.fileHandleForWriting.close()
            let fd = output.fileHandleForReading.fileDescriptor
            guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { process.terminate(); throw LocalMacAgentIdentityBlockReason.unavailable }
            var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            let deadline = Date().addingTimeInterval(30); var failure: LocalMacAgentIdentityBlockReason?
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count > 0 { bytes.append(contentsOf: buffer.prefix(count)); if bytes.count > 65536 { failure = .protocolError; break } }
                else if count == 0 && !process.isRunning { break }
                else if errno != EAGAIN && errno != EINTR { failure = .unavailable; break }
                if Date() >= deadline { failure = .timedOut; break }
                if Task.isCancelled { failure = .cancelled; break }
                do { try await Task.sleep(for: .milliseconds(10)) } catch { failure = .cancelled; break }
            }
            if failure != nil && process.isRunning { process.terminate(); usleep(50_000); if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
            process.waitUntilExit(); try? output.fileHandleForReading.close()
            if let failure { throw failure }
            return bytes // Failure replies exit1; the strict reply parser distinguishes missing/blocked.
        }
        return try await withTaskCancellationHandler { try await child.value } onCancel: { child.cancel() }
    }
}
extension LocalMacAgentIdentityBlockReason: Error {}
#endif
