#if os(macOS)
import Darwin
import Foundation

extension LocalMacAgentSetup {
    /// First preparation without a browser. Both complete native helper packages are staged before the
    /// root becomes visible. No browser placeholder, identity provisioning, pairing, bot grant or launch.
    public static func prepareCuaOnly(bundle: LocalMacAgentSetupBundle, helper: LocalMacAgentHelperPackage,
                                      cuaPackage: LocalMacAgentCuaPackage, location: LocalMacAgentSetupLocation,
                                      name: String = "Dexter Mac", now: Date = Date()) throws -> LocalMacAgentSelection {
        guard !bundle.offer.isExpired(now: now) else { throw LocalMacAgentSetupError.offerExpired }
        guard matches(name, "^[\\p{L}\\p{N} ._-]{1,48}$"), matches(bundle.installationID, wireID),
              validBrowserExecutable(helper.executable), validBrowserExecutable(cuaPackage.executable),
              helper.application?.kind == nil || helper.application?.kind == .identity,
              cuaPackage.application?.kind == nil || cuaPackage.application?.kind == .cua else { throw LocalMacAgentSetupError.invalidInput }
        let parent = location.root.deletingLastPathComponent()
        guard canonical(parent), realDirectories(parent) else { throw LocalMacAgentSetupError.unsafeLocation }
        var existing = stat()
        guard lstat(location.root.path, &existing) != 0, errno == ENOENT else { throw LocalMacAgentSetupError.conflict }
        let stagingRoot = parent.appendingPathComponent(".dexter-cua-prepare-" + UUID().uuidString, isDirectory: true)
        guard mkdir(stagingRoot.path, 0o700) == 0 else { throw LocalMacAgentSetupError.writeFailed }
        var committed = false
        defer { if !committed { try? FileManager.default.removeItem(at: stagingRoot) } }
        let stage = LocalMacAgentSetupLocation(root: stagingRoot)
        for directory in [stage.helperDirectory, stage.dataDirectory] { guard mkdir(directory.path, 0o700) == 0 else { throw LocalMacAgentSetupError.writeFailed } }
        func stageHelper(source: URL, app: NativeHelperApplication?, kind: NativeHelperApplication.Kind, destination: URL) throws {
            if let app { _ = try app.stage(to: destination) }
            else {
                let bytes = try Data(contentsOf: source); guard !bytes.isEmpty, bytes.count <= 64 * 1024 * 1024 else { throw LocalMacAgentSetupError.invalidInput }
                try cuaOnlyWrite(bytes, to: destination, mode: 0o700)
                guard validBrowserExecutable(source), try Data(contentsOf: source) == bytes else { throw LocalMacAgentSetupError.conflict }
            }
        }
        try stageHelper(source: helper.executable, app: helper.application, kind: .identity,
                        destination: helper.application == nil ? stage.helper : stage.helperApplication)
        try stageHelper(source: cuaPackage.executable, app: cuaPackage.application, kind: .cua,
                        destination: cuaPackage.application == nil ? stage.cuaHelper : stage.cuaApplication)
        let identityTarget = helper.application == nil ? location.helper : location.boundHelper
        let cuaTarget = cuaPackage.application == nil ? location.cuaHelper : location.boundCuaHelper
        let helperDocument: [String: Any] = ["installationID": bundle.installationID, "hostURL": bundle.offer.hostURL,
            "hostCertificateDER": bundle.offer.certificateDER.base64EncodedString(), "hostFingerprint": bundle.offer.hostFingerprint]
        let config: [String: Any] = ["version": 2, "mode": "local-capabilities", "name": name, "dataDir": location.dataDirectory.path,
            "capabilities": LocalMacAgentCuaAuthorization.operations, "hostUrl": bundle.offer.hostURL,
            "hostCertPath": location.hostCertificate.path, "hostFingerprint": bundle.offer.hostFingerprint,
            "client": ["kind": "native-helper", "executable": identityTarget.path, "configPath": location.helperConfiguration.path,
                       "installationID": bundle.installationID, "identityMode": "production"],
            "policyPath": location.policy.path, "browser": NSNull(), "cua": ["mode": "native", "executable": cuaTarget.path]]
        let base64 = bundle.offer.certificateDER.base64EncodedString(); var pem = "-----BEGIN CERTIFICATE-----\n"
        var rest = Substring(base64); while !rest.isEmpty { pem += rest.prefix(64) + "\n"; rest = rest.dropFirst(64) }; pem += "-----END CERTIFICATE-----\n"
        let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        try cuaOnlyWrite(Data(pem.utf8), to: stage.hostCertificate)
        try cuaOnlyWrite(try JSONSerialization.data(withJSONObject: helperDocument, options: options), to: stage.helperConfiguration)
        try cuaOnlyWrite(Data(#"{"bots":[],"version":1}"#.utf8), to: stage.policy)
        try cuaOnlyWrite(try JSONSerialization.data(withJSONObject: config, options: options), to: stage.configuration)
        let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw LocalMacAgentSetupError.unsafeLocation }; defer { close(directory) }
        let staged = open(stagingRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard staged >= 0 else { throw LocalMacAgentSetupError.unsafeLocation }; defer { close(staged) }
        var before = stat(), current = stat()
        guard fstat(staged, &before) == 0, lstat(stagingRoot.path, &current) == 0, before.st_ino == current.st_ino, before.st_dev == current.st_dev,
              canonical(parent), fsync(staged) == 0,
              renameatx_np(directory, stagingRoot.lastPathComponent, directory, location.root.lastPathComponent, UInt32(RENAME_EXCL)) == 0 else { throw LocalMacAgentSetupError.writeFailed }
        committed = true
        guard fsync(directory) == 0 else { throw LocalMacAgentCuaSetupError.outcomeUnknown }
        let selection = try LocalMacAgentSelection(configurationURL: location.configuration)
        _ = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: bundle.installationID)
        return selection
    }
    private static func cuaOnlyWrite(_ bytes: Data, to url: URL, mode: mode_t = 0o600) throws {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
        guard fd >= 0 else { throw LocalMacAgentSetupError.conflict }; defer { close(fd) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: bytes)
        guard fsync(fd) == 0 else { throw LocalMacAgentSetupError.writeFailed }
    }
}
#endif
