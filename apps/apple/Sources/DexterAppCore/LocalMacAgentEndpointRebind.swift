#if os(macOS)
import Darwin
import Foundation
import DexterHostClient

public enum LocalMacAgentEndpointRebindError: Error, Sendable { case invalidInput, conflict, agentMustBeStopped, unsafeLocation, outcomeUnknown }
public enum LocalMacAgentEndpointRebindState: String, Codable, Sendable { case committed, unknown, conflict }
public struct LocalMacAgentEndpointRebindReceipt: Equatable, Codable, Sendable {
    public let requestID: String
    public let requestHash: String
    public let installationID: String
    public let hostFingerprint: String
    public let oldHostURL: String
    public let newHostURL: String
    public let state: LocalMacAgentEndpointRebindState
}
private struct EndpointTarget { let installationID: String; let hostURL: String; let hostFingerprint: String; let certificateDER: Data }
private struct EndpointGuard: Codable, Equatable { let path: String; let digest: String; let maximum: Int; let executable: Bool }
private struct EndpointIntent: Codable, Equatable {
    let schema: String; let requestID: String; let root: String; let installationID: String; let hostFingerprint: String
    let oldHostURL: String; let newHostURL: String
    let oldConfig: String; let newConfig: String; let oldHelper: String; let newHelper: String
    let guards: [EndpointGuard]; let identityApp: String?; let cuaApp: String?
}
private struct EndpointJournal: Codable { let intent: EndpointIntent; let requestHash: String }
private struct EndpointPointer: Codable { let requestID: String; let requestHash: String }
/// Immutable history only, never authority to start, grant or mutate the current installation.
private struct EndpointCompletion: Codable, Equatable {
    let schema: String
    let requestID: String; let requestHash: String; let root: String
    let installationID: String; let hostFingerprint: String; let oldHostURL: String; let newHostURL: String
    let newConfig: String; let newHelper: String
    init(_ journal: EndpointJournal) {
        schema = "dexter.endpoint-rebind-completion/1"
        requestID = journal.intent.requestID; requestHash = journal.requestHash; root = journal.intent.root
        installationID = journal.intent.installationID; hostFingerprint = journal.intent.hostFingerprint
        oldHostURL = journal.intent.oldHostURL; newHostURL = journal.intent.newHostURL
        newConfig = journal.intent.newConfig; newHelper = journal.intent.newHelper
    }
}
extension LocalMacAgentSetup {
    /// Exact same host installation/pin/DER only. This mutation changes precisely the two endpoint fields.
    /// Any partial/uncertain attempt must be reconciled read-only; it is never completed or rolled back automatically.
    public static func rebindEndpoint(bundle: LocalMacAgentSetupBundle, selection: LocalMacAgentSelection,
                                      expectedSnapshot: LocalMacAgentPolicySnapshot, agentStopped: Bool,
                                      requestID: String = UUID().uuidString) throws -> LocalMacAgentSelection {
        try rebindEndpoint(bundle: bundle, selection: selection, expectedSnapshot: expectedSnapshot,
                           agentStopped: agentStopped, requestID: requestID, afterFirstWrite: {})
    }
    /// Reconnect the previously authorized same installation to GET-only public channel metadata.
    /// The caller must bind metadata to this app's exact owned ready endpoint and stopped agent.
    public static func rebindEndpoint(connection: LocalMacAgentConnectionDescription, selection: LocalMacAgentSelection,
                                     expectedSnapshot: LocalMacAgentPolicySnapshot, agentStopped: Bool,
                                     requestID: String = UUID().uuidString) throws -> LocalMacAgentSelection {
        try rebindEndpoint(target: EndpointTarget(installationID: connection.installationID, hostURL: connection.hostURL,
            hostFingerprint: connection.hostFingerprint, certificateDER: connection.certificateDER), selection: selection,
            expectedSnapshot: expectedSnapshot, agentStopped: agentStopped, requestID: requestID, afterFirstWrite: {})
    }
    static func rebindEndpoint(bundle: LocalMacAgentSetupBundle, selection: LocalMacAgentSelection,
                               expectedSnapshot: LocalMacAgentPolicySnapshot, agentStopped: Bool, requestID: String,
                               afterFirstWrite: () throws -> Void) throws -> LocalMacAgentSelection {
        guard !bundle.offer.isExpired() else { throw LocalMacAgentEndpointRebindError.invalidInput }
        return try rebindEndpoint(target: EndpointTarget(installationID: bundle.installationID, hostURL: bundle.offer.hostURL,
            hostFingerprint: bundle.offer.hostFingerprint, certificateDER: bundle.offer.certificateDER), selection: selection,
            expectedSnapshot: expectedSnapshot, agentStopped: agentStopped, requestID: requestID, afterFirstWrite: afterFirstWrite)
    }
    private static func rebindEndpoint(target: EndpointTarget, selection: LocalMacAgentSelection,
                               expectedSnapshot: LocalMacAgentPolicySnapshot, agentStopped: Bool, requestID: String,
                               afterFirstWrite: () throws -> Void) throws -> LocalMacAgentSelection {
        guard agentStopped else { throw LocalMacAgentEndpointRebindError.agentMustBeStopped }
        guard UUID(uuidString: requestID) != nil, validHostURL(target.hostURL) else { throw LocalMacAgentEndpointRebindError.invalidInput }
        let location = LocalMacAgentSetupLocation(root: selection.configurationURL.deletingLastPathComponent())
        let store = try EndpointStore(location)
        try store.lock(); defer { store.unlock() }
        if let original: EndpointJournal = try store.read(journalName(requestID)) {
            try checkJournal(original, location: location)
            guard original.intent.requestID == requestID, original.intent.installationID == target.installationID,
                  original.intent.newHostURL == target.hostURL, original.intent.hostFingerprint == target.hostFingerprint else { throw LocalMacAgentEndpointRebindError.conflict }
            let receipt = try reconcile(original, location: location)
            guard receipt.state == .committed else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
            // Historical receipt is not current launch authority. A duplicate never rewrites an endpoint
            // subsequently moved by a different request, or accepts a changed installation/pin/DER.
            let current = try LocalMacAgentSelection(configurationURL: location.configuration)
            _ = try LocalMacAgentPolicy.read(selection: current, expectedInstallationID: target.installationID)
            let helper = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(location.helperConfiguration, maximum: 32768)) as? [String: Any]
            guard current.hostURL == target.hostURL, helper?["hostFingerprint"] as? String == target.hostFingerprint,
                  helper?["hostCertificateDER"] as? String == target.certificateDER.base64EncodedString() else { throw LocalMacAgentEndpointRebindError.conflict }
            return current
        }
        // Orphan/forged completion cannot pre-authorize a new write. Nothing overwrites a marker.
        guard try store.readCompletion(completionName(requestID)) == nil else { throw LocalMacAgentEndpointRebindError.conflict }
        if let pointer: EndpointPointer = try store.read(".endpoint-rebind-active.json") {
            guard let previous: EndpointJournal = try store.read(journalName(pointer.requestID)),
                  previous.intent.requestID == pointer.requestID, pointer.requestHash == previous.requestHash else { throw LocalMacAgentEndpointRebindError.conflict }
            guard try reconcile(previous, location: location).state == .committed else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
        }
        guard selection.configurationURL == location.configuration,
              try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: target.installationID) == expectedSnapshot else { throw LocalMacAgentEndpointRebindError.conflict }
        let configBytes = try LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384)
        let helperBytes = try LocalMacAgentPolicy.privateRead(location.helperConfiguration, maximum: 32768)
        guard var config = try JSONSerialization.jsonObject(with: configBytes) as? [String: Any],
              var helper = try JSONSerialization.jsonObject(with: helperBytes) as? [String: Any],
              helper["installationID"] as? String == target.installationID,
              helper["hostFingerprint"] as? String == target.hostFingerprint,
              helper["hostCertificateDER"] as? String == target.certificateDER.base64EncodedString(),
              config["hostFingerprint"] as? String == target.hostFingerprint else { throw LocalMacAgentEndpointRebindError.conflict }
        let certificate = try LocalMacAgentPolicy.privateRead(location.hostCertificate, maximum: 16384)
        guard let pem = String(data: certificate, encoding: .utf8), singleCertificateDER(pem) == target.certificateDER else { throw LocalMacAgentEndpointRebindError.conflict }
        config["hostUrl"] = target.hostURL; helper["hostURL"] = target.hostURL
        let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        let nextConfig = try JSONSerialization.data(withJSONObject: config, options: options)
        let nextHelper = try JSONSerialization.data(withJSONObject: helper, options: options)
        var refs: [EndpointGuard] = []
        func capture(_ url: URL, maximum: Int, executable: Bool = false, optional: Bool = false) throws {
            var status = stat()
            if lstat(url.path, &status) != 0 && errno == ENOENT && optional {
                refs.append(EndpointGuard(path: url.path, digest: "absent", maximum: maximum, executable: executable)); return
            }
            refs.append(EndpointGuard(path: url.path, digest: sha256Hex(try LocalMacAgentPolicy.privateRead(url, maximum: maximum, executable: executable)), maximum: maximum, executable: executable))
        }
        try capture(location.hostCertificate, maximum: 16384); try capture(location.policy, maximum: 1024 * 1024)
        try capture(location.dataDirectory.appendingPathComponent("binding.json"), maximum: 16384, optional: true)
        try capture(location.dataDirectory.appendingPathComponent("native-device.json"), maximum: 16384, optional: true)
        guard let client = config["client"] as? [String: Any], let helperPath = client["executable"] as? String else { throw LocalMacAgentEndpointRebindError.conflict }
        try capture(URL(fileURLWithPath: helperPath), maximum: 64 * 1024 * 1024, executable: true)
        var cuaPath: String?
        if let cua = config["cua"] as? [String: Any], let path = cua["executable"] as? String { cuaPath = path; try capture(URL(fileURLWithPath: path), maximum: 64 * 1024 * 1024, executable: true) }
        if let files = config["files"] as? [String: Any], let path = files["policyPath"] as? String { try capture(URL(fileURLWithPath: path), maximum: 1024 * 1024) }
        let identityApp = helperPath == location.boundHelper.path ? try appDigest(location.helperApplication, kind: .identity) : nil
        let cuaApp = cuaPath == location.boundCuaHelper.path ? try appDigest(location.cuaApplication, kind: .cua) : nil
        let intent = EndpointIntent(schema: "dexter.endpoint-rebind/1", requestID: requestID, root: location.root.path,
            installationID: target.installationID, hostFingerprint: target.hostFingerprint,
            oldHostURL: selection.hostURL, newHostURL: target.hostURL,
            oldConfig: sha256Hex(configBytes), newConfig: sha256Hex(nextConfig), oldHelper: sha256Hex(helperBytes), newHelper: sha256Hex(nextHelper),
            guards: refs, identityApp: identityApp, cuaApp: cuaApp)
        let journal = EndpointJournal(intent: intent, requestHash: try intentHash(intent))
        try checkJournal(journal, location: location)
        guard try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: target.installationID) == expectedSnapshot else { throw LocalMacAgentEndpointRebindError.conflict }
        // Both immutable original documents are represented only by SHA256, not copied into the journal.
        try store.write(journal, name: journalName(requestID))
        try store.write(EndpointPointer(requestID: requestID, requestHash: journal.requestHash), name: ".endpoint-rebind-active.json")
        do {
            try validateGuards(intent, location: location)
            try store.replace(nextConfig, name: "config.json", expected: intent.oldConfig, maximum: 16384)
            try afterFirstWrite()
            try validateGuards(intent, location: location)
            guard sha256Hex(try LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384)) == intent.newConfig else { throw LocalMacAgentEndpointRebindError.conflict }
            try store.replace(nextHelper, name: "identity-helper.json", expected: intent.oldHelper, maximum: 32768)
            let next = try LocalMacAgentSelection(configurationURL: location.configuration)
            _ = try LocalMacAgentPolicy.read(selection: next, expectedInstallationID: target.installationID)
            guard try reconcile(journal, location: location).state == .committed else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
            // Only this effect path has proved both writes and ALL original guards. GET never creates
            // completion, including legacy committed snapshots or a lost ACK before marker durability.
            try store.writeCompletion(EndpointCompletion(journal), name: completionName(requestID))
            guard try store.readCompletion(completionName(requestID)) == EndpointCompletion(journal) else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
            return next
        } catch { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
    }
    public static func reconcileEndpointRebind(location: LocalMacAgentSetupLocation,
                                             requestID: String? = nil) throws -> LocalMacAgentEndpointRebindReceipt? {
        let store = try EndpointStore(location)
        let pointer: EndpointPointer? = try store.read(".endpoint-rebind-active.json")
        guard let id = requestID ?? pointer?.requestID else { return nil }
        guard UUID(uuidString: id) != nil else { throw LocalMacAgentEndpointRebindError.invalidInput }
        guard let journal: EndpointJournal = try store.read(journalName(id)) else { return nil }
        guard journal.intent.requestID == id else { throw LocalMacAgentEndpointRebindError.conflict }
        if requestID == nil { guard pointer?.requestHash == journal.requestHash else { throw LocalMacAgentEndpointRebindError.conflict } }
        return try reconcile(journal, location: location)
    }
    private static func journalName(_ id: String) -> String { ".endpoint-rebind-" + sha256Hex(Data(id.utf8)) + ".json" }
    private static func completionName(_ id: String) -> String { ".endpoint-rebind-completed-" + sha256Hex(Data(id.utf8)) + ".json" }
    private static func intentHash(_ intent: EndpointIntent) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return sha256Hex(try encoder.encode(intent))
    }
    private static func appDigest(_ url: URL, kind: NativeHelperApplication.Kind) throws -> String {
        try NativeHelperApplication(bundle: url, kind: kind).snapshot().digest.map { String(format: "%02x", $0) }.joined()
    }
    private static func checkJournal(_ journal: EndpointJournal, location: LocalMacAgentSetupLocation) throws {
        let value = journal.intent
        guard value.schema == "dexter.endpoint-rebind/1", UUID(uuidString: value.requestID) != nil, value.root == location.root.path,
              matches(value.installationID, wireID), matches(value.hostFingerprint, "^[a-f0-9]{64}$"), validHostURL(value.oldHostURL), validHostURL(value.newHostURL),
              [value.oldConfig, value.newConfig, value.oldHelper, value.newHelper].allSatisfy({ matches($0, "^[a-f0-9]{64}$") }),
              value.guards.count >= 5, value.guards.count <= 8, Set(value.guards.map(\.path)).count == value.guards.count,
              journal.requestHash == (try intentHash(value)) else { throw LocalMacAgentEndpointRebindError.conflict }
    }
    private static func validateGuards(_ intent: EndpointIntent, location: LocalMacAgentSetupLocation) throws {
        for guardValue in intent.guards {
            let url = URL(fileURLWithPath: guardValue.path)
            // Guard paths must be reconstructible from current public config, never arbitrary receipt authority.
            let config = try JSONSerialization.jsonObject(with: LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384)) as? [String: Any]
            let client = config?["client"] as? [String: Any], cua = config?["cua"] as? [String: Any], files = config?["files"] as? [String: Any]
            let paths: Set<String> = [location.hostCertificate.path, location.policy.path, location.dataDirectory.appendingPathComponent("binding.json").path,
                location.dataDirectory.appendingPathComponent("native-device.json").path, client?["executable"] as? String ?? "", cua?["executable"] as? String ?? "", files?["policyPath"] as? String ?? ""]
            guard paths.contains(url.path), [16384, 32768, 1024 * 1024, 64 * 1024 * 1024].contains(guardValue.maximum) else { throw LocalMacAgentEndpointRebindError.conflict }
            if guardValue.digest == "absent" {
                var status = stat(); guard lstat(url.path, &status) != 0, errno == ENOENT else { throw LocalMacAgentEndpointRebindError.conflict }
            } else {
                guard sha256Hex(try LocalMacAgentPolicy.privateRead(url, maximum: guardValue.maximum, executable: guardValue.executable)) == guardValue.digest else { throw LocalMacAgentEndpointRebindError.conflict }
            }
        }
        if let hash = intent.identityApp { guard try appDigest(location.helperApplication, kind: .identity) == hash else { throw LocalMacAgentEndpointRebindError.conflict } }
        if let hash = intent.cuaApp { guard try appDigest(location.cuaApplication, kind: .cua) == hash else { throw LocalMacAgentEndpointRebindError.conflict } }
    }
    private static func reconcile(_ journal: EndpointJournal, location: LocalMacAgentSetupLocation) throws -> LocalMacAgentEndpointRebindReceipt {
        try checkJournal(journal, location: location)
        let intent = journal.intent
        let store = try EndpointStore(location)
        if let completed = try store.readCompletion(completionName(intent.requestID)) {
            guard completed == EndpointCompletion(journal) else { throw LocalMacAgentEndpointRebindError.conflict }
            var state: LocalMacAgentEndpointRebindState = .committed
            do { try validateCompletedTrust(intent, location: location) } catch { state = .conflict }
            // This is a historical terminal receipt. Current config/policy/binding may legitimately
            // differ; each future mutation/launch still requires fresh policy, pin/DER and scope checks.
            return LocalMacAgentEndpointRebindReceipt(requestID: intent.requestID, requestHash: journal.requestHash,
                installationID: intent.installationID, hostFingerprint: intent.hostFingerprint,
                oldHostURL: intent.oldHostURL, newHostURL: intent.newHostURL, state: state)
        }
        let config = sha256Hex(try LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384))
        let helper = sha256Hex(try LocalMacAgentPolicy.privateRead(location.helperConfiguration, maximum: 32768))
        var state: LocalMacAgentEndpointRebindState = .unknown
        if ![intent.oldConfig, intent.newConfig].contains(config) || ![intent.oldHelper, intent.newHelper].contains(helper) { state = .conflict }
        if state != .conflict {
            do {
                try validateGuards(intent, location: location)
                if config == intent.newConfig && helper == intent.newHelper {
                    let selection = try LocalMacAgentSelection(configurationURL: location.configuration)
                    _ = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: intent.installationID); state = .committed
                }
            } catch { state = .conflict }
        }
        return LocalMacAgentEndpointRebindReceipt(requestID: intent.requestID, requestHash: journal.requestHash,
            installationID: intent.installationID, hostFingerprint: intent.hostFingerprint, oldHostURL: intent.oldHostURL, newHostURL: intent.newHostURL, state: state)
    }
    /// Mutable authorizations/binding/config are history after completion; package/trust integrity
    /// remains guarded. Receipt paths never authorize reading a newly caller-selected arbitrary file.
    private static func validateCompletedTrust(_ intent: EndpointIntent, location: LocalMacAgentSetupLocation) throws {
        let executables: Set<String> = [location.helper.path, location.boundHelper.path, location.cuaHelper.path, location.boundCuaHelper.path]
        for value in intent.guards where value.path == location.hostCertificate.path || executables.contains(value.path) {
            let executable = executables.contains(value.path)
            guard value.executable == executable, value.maximum == (executable ? 64 * 1024 * 1024 : 16384),
                  matches(value.digest, "^[a-f0-9]{64}$"),
                  sha256Hex(try LocalMacAgentPolicy.privateRead(URL(fileURLWithPath: value.path), maximum: value.maximum, executable: executable)) == value.digest else {
                throw LocalMacAgentEndpointRebindError.conflict
            }
        }
        if let hash = intent.identityApp { guard try appDigest(location.helperApplication, kind: .identity) == hash else { throw LocalMacAgentEndpointRebindError.conflict } }
        if let hash = intent.cuaApp { guard try appDigest(location.cuaApplication, kind: .cua) == hash else { throw LocalMacAgentEndpointRebindError.conflict } }
    }
}
private final class EndpointStore {
    let location: LocalMacAgentSetupLocation; let directory: Int32; private var lockFile: Int32 = -1
    init(_ location: LocalMacAgentSetupLocation) throws {
        guard LocalMacAgentSetup.canonical(location.root), LocalMacAgentSetup.realDirectories(location.root) else { throw LocalMacAgentEndpointRebindError.unsafeLocation }
        _ = try LocalMacAgentSetup.privateDirectory(location.root); self.location = location
        directory = open(location.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw LocalMacAgentEndpointRebindError.unsafeLocation }
    }
    deinit { unlock(); close(directory) }
    func assertDirectory() throws {
        var opened = stat(), current = stat()
        guard fstat(directory, &opened) == 0, lstat(location.root.path, &current) == 0, current.st_mode & S_IFMT == S_IFDIR,
              current.st_dev == opened.st_dev, current.st_ino == opened.st_ino else { throw LocalMacAgentEndpointRebindError.conflict }
    }
    func lock() throws {
        lockFile = openat(directory, ".endpoint-rebind.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        var status = stat()
        guard lockFile >= 0, fstat(lockFile, &status) == 0, status.st_mode & S_IFMT == S_IFREG, status.st_nlink == 1,
              status.st_uid == getuid(), status.st_mode & 0o777 == 0o600, flock(lockFile, LOCK_EX | LOCK_NB) == 0 else { throw LocalMacAgentEndpointRebindError.conflict }
    }
    func unlock() { if lockFile >= 0 { _ = flock(lockFile, LOCK_UN); close(lockFile); lockFile = -1 } }
    func read<T: Decodable>(_ name: String) throws -> T? {
        try assertDirectory(); guard !name.contains("/"), name.hasPrefix(".endpoint-rebind") else { throw LocalMacAgentEndpointRebindError.invalidInput }
        var status = stat(); if fstatat(directory, name, &status, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT { return nil }
        let bytes = try LocalMacAgentPolicy.privateRead(location.root.appendingPathComponent(name), maximum: 65536)
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw LocalMacAgentEndpointRebindError.conflict }
        if T.self == EndpointJournal.self {
            let required: Set<String> = ["schema", "requestID", "root", "installationID", "hostFingerprint", "oldHostURL", "newHostURL", "oldConfig", "newConfig", "oldHelper", "newHelper", "guards"]
            guard Set(object.keys) == ["intent", "requestHash"], let intent = object["intent"] as? [String: Any],
                  required.isSubset(of: Set(intent.keys)), Set(intent.keys).isSubset(of: required.union(["identityApp", "cuaApp"])),
                  let guards = intent["guards"] as? [[String: Any]],
                  guards.allSatisfy({ Set($0.keys) == ["path", "digest", "maximum", "executable"] }) else { throw LocalMacAgentEndpointRebindError.conflict }
        } else if T.self == EndpointPointer.self {
            guard Set(object.keys) == ["requestID", "requestHash"] else { throw LocalMacAgentEndpointRebindError.conflict }
        }
        return try JSONDecoder().decode(T.self, from: bytes)
    }
    func readCompletion(_ name: String) throws -> EndpointCompletion? {
        try assertDirectory()
        guard !name.contains("/"), name.hasPrefix(".endpoint-rebind-completed-") else { throw LocalMacAgentEndpointRebindError.invalidInput }
        var status = stat()
        if fstatat(directory, name, &status, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT { return nil }
        let bytes = try LocalMacAgentPolicy.privateRead(location.root.appendingPathComponent(name), maximum: 4096)
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == ["schema", "requestID", "requestHash", "root", "installationID", "hostFingerprint", "oldHostURL", "newHostURL", "newConfig", "newHelper"],
              object["schema"] as? String == "dexter.endpoint-rebind-completion/1" else { throw LocalMacAgentEndpointRebindError.conflict }
        return try JSONDecoder().decode(EndpointCompletion.self, from: bytes)
    }
    func writeCompletion(_ value: EndpointCompletion, name: String) throws {
        try assertDirectory()
        guard !name.contains("/"), name.hasPrefix(".endpoint-rebind-completed-") else { throw LocalMacAgentEndpointRebindError.invalidInput }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bytes = try encoder.encode(value)
        guard bytes.count <= 4096 else { throw LocalMacAgentEndpointRebindError.invalidInput }
        let fd = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }; defer { close(fd) }
        // A partial marker remains blocked; no cleanup/rewrite/replay can invent a completion.
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: bytes)
        try assertDirectory()
        guard fsync(fd) == 0, fsync(directory) == 0 else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
    }
    func write<T: Encodable>(_ value: T, name: String) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try atomic(encoder.encode(value), name: name, expected: nil, maximum: 65536)
    }
    func replace(_ bytes: Data, name: String, expected: String, maximum: Int) throws { try atomic(bytes, name: name, expected: expected, maximum: maximum) }
    private func atomic(_ bytes: Data, name: String, expected: String?, maximum: Int) throws {
        try assertDirectory(); guard !name.contains("/"), bytes.count <= maximum else { throw LocalMacAgentEndpointRebindError.invalidInput }
        let temporary = ".endpoint-rebind-tmp-" + UUID().uuidString
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }; defer { close(fd); _ = unlinkat(directory, temporary, 0) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: bytes)
        guard fsync(fd) == 0 else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
        if let expected { guard LocalMacAgentSetup.sha256Hex(try LocalMacAgentPolicy.privateRead(location.root.appendingPathComponent(name), maximum: maximum)) == expected else { throw LocalMacAgentEndpointRebindError.conflict } }
        try assertDirectory()
        guard renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0 else { throw LocalMacAgentEndpointRebindError.outcomeUnknown }
    }
}
#endif
