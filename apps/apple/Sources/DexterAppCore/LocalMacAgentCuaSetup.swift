#if os(macOS)
import Darwin
import Foundation

public enum LocalMacAgentCuaSetupError: Error, Sendable { case unavailable, conflict, agentMustBeStopped, outcomeUnknown }

public struct LocalMacAgentCuaPackage: Equatable, Sendable {
    public let executable: URL
    public let application: NativeHelperApplication?
    public init(executable: URL) { self.executable = executable;application=nil }
    public init(application:NativeHelperApplication) { executable=application.executable;self.application=application }
    public static func packaged(in bundle: Bundle = .main) throws -> Self {
        let contents = bundle.bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let metadata = contents.appendingPathComponent("Resources/DexterLocalHost/mac-cua-helper.json")
        guard LocalMacAgentSetup.canonical(contents), LocalMacAgentSetup.realDirectories(metadata.deletingLastPathComponent()),
              let data = try? metadataBytes(metadata), data.count <= 4096,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LocalMacAgentCuaSetupError.unavailable }
        if object["schema"] as? String == "dexter.mac-cua-helper/2" {
            guard Set(object.keys)==["schema","helper","executable","automaticStart"],object["automaticStart"] as? Bool==false,
                  object["helper"] as? String=="Helpers/DexterControl.app",object["executable"] as? String=="Contents/MacOS/dexter-cua-helper" else { throw LocalMacAgentCuaSetupError.unavailable }
            return try Self(application:NativeHelperApplication(bundle:contents.appendingPathComponent("Helpers/DexterControl.app"),kind:.cua))
        }
        guard Set(object.keys) == ["schema", "helper", "automaticStart"],
              object["schema"] as? String == "dexter.mac-cua-helper/1", object["automaticStart"] as? Bool == false,
              object["helper"] as? String == "Helpers/dexter-cua-helper" else { throw LocalMacAgentCuaSetupError.unavailable }
        let executable = contents.appendingPathComponent("Helpers/dexter-cua-helper")
        guard LocalMacAgentSetup.validBrowserExecutable(executable) else { throw LocalMacAgentCuaSetupError.unavailable }
        return Self(executable: executable)
    }
    private static func metadataBytes(_ url: URL) throws -> Data {
        guard LocalMacAgentSetup.canonical(url) else { throw LocalMacAgentCuaSetupError.unavailable }
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw LocalMacAgentCuaSetupError.unavailable }; defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= 4096,
              info.st_mode & 0o022 == 0, info.st_uid == getuid() || info.st_uid == 0 else { throw LocalMacAgentCuaSetupError.unavailable }
        let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: 4097) ?? Data()
        guard data.count == info.st_size else { throw LocalMacAgentCuaSetupError.unavailable }
        return data
    }
}

public enum LocalMacAgentCuaSetup {
    /// Explicit stopped-agent action. Two durable files are not a transaction: any partial result is unknown.
    public static func configure(package: LocalMacAgentCuaPackage, selection: LocalMacAgentSelection,
                                 expectedInstallationID: String, agentStopped: Bool) throws -> LocalMacAgentSelection {
        guard agentStopped else { throw LocalMacAgentCuaSetupError.agentMustBeStopped }
        let expected = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: expectedInstallationID)
        let location = LocalMacAgentSetupLocation(root: selection.configurationURL.deletingLastPathComponent())
        let original = try LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384)
        guard var config = try JSONSerialization.jsonObject(with: original) as? [String: Any],
              let capabilities = config["capabilities"] as? [String],
              LocalMacAgentSetup.validBrowserExecutable(package.executable) else { throw LocalMacAgentCuaSetupError.unavailable }
        let source = try sourceBytes(package.executable)
        if let app=package.application,app.kind != .cua { throw LocalMacAgentCuaSetupError.unavailable }
        let target=package.application == nil ? location.cuaHelper : location.boundCuaHelper
        let configured = config["cua"] as? [String: Any]
        if let configured {
            guard Set(configured.keys) == ["mode", "executable"], configured["mode"] as? String == "native",
                  configured["executable"] as? String == target.path,
                  try LocalMacAgentPolicy.privateRead(target, maximum: 64 * 1024 * 1024, executable: true) == source else {
                throw LocalMacAgentCuaSetupError.conflict
            }
            if let app=package.application {
                guard try app.snapshot()==NativeHelperApplication(bundle:location.cuaApplication,kind:.cua).snapshot() else { throw LocalMacAgentCuaSetupError.conflict }
            }
        } else {
            guard config["cua"] is NSNull else { throw LocalMacAgentCuaSetupError.conflict }
            var existing = stat()
            let path=package.application == nil ? location.cuaHelper.path : location.cuaApplication.path
            guard lstat(path, &existing) != 0, errno == ENOENT else { throw LocalMacAgentCuaSetupError.conflict }
        }
        config["cua"] = ["mode": "native", "executable": target.path]
        config["capabilities"] = Array(Set(capabilities + LocalMacAgentCuaAuthorization.operations)).sorted()
        let next = try JSONSerialization.data(withJSONObject: config, options: [.sortedKeys, .withoutEscapingSlashes])
        guard next.count <= 16384, try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: expectedInstallationID) == expected else {
            throw LocalMacAgentCuaSetupError.conflict
        }
        if configured != nil, next == original { return selection }
        do {
            if configured == nil {
                if let app=package.application { _=try app.stage(to:location.cuaApplication) }
                else { try publishHelper(source, location: location) }
            }
            try replaceConfiguration(next, original: original, expected: expected, location: location,
                                     selection: selection, installationID: expectedInstallationID)
            return try LocalMacAgentSelection(configurationURL: location.configuration)
        } catch { throw LocalMacAgentCuaSetupError.outcomeUnknown }
    }

    private static func sourceBytes(_ url: URL) throws -> Data {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw LocalMacAgentCuaSetupError.unavailable }; defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size > 0,
              before.st_size <= 64 * 1024 * 1024, before.st_mode & 0o022 == 0, before.st_mode & 0o111 != 0,
              before.st_uid == getuid() || before.st_uid == 0 else { throw LocalMacAgentCuaSetupError.unavailable }
        let bytes = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).read(upToCount: 64 * 1024 * 1024 + 1) ?? Data()
        var after = stat()
        guard bytes.count == before.st_size, fstat(fd, &after) == 0, before.st_ino == after.st_ino, before.st_dev == after.st_dev, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else {
            throw LocalMacAgentCuaSetupError.conflict
        }
        return bytes
    }
    private static func directory(_ url: URL) throws -> Int32 {
        guard LocalMacAgentSetup.canonical(url), LocalMacAgentSetup.realDirectories(url) else { throw LocalMacAgentCuaSetupError.conflict }
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw LocalMacAgentCuaSetupError.conflict }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            close(fd); throw LocalMacAgentCuaSetupError.conflict
        }
        return fd
    }
    private static func publishHelper(_ bytes: Data, location: LocalMacAgentSetupLocation) throws {
        let dir = try directory(location.helperDirectory); defer { close(dir) }
        let fd = openat(dir, location.cuaHelper.lastPathComponent, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o700)
        guard fd >= 0 else { throw LocalMacAgentCuaSetupError.conflict }; defer { close(fd) }
        let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
        guard written == bytes.count, fchmod(fd, 0o700) == 0, fsync(fd) == 0, fsync(dir) == 0 else { throw LocalMacAgentCuaSetupError.outcomeUnknown }
    }
    private static func replaceConfiguration(_ bytes: Data, original: Data, expected: LocalMacAgentPolicySnapshot,
                                              location: LocalMacAgentSetupLocation, selection: LocalMacAgentSelection,
                                              installationID: String) throws {
        let dir = try directory(location.root); defer { close(dir) }
        var opened = stat(); guard fstat(dir, &opened) == 0 else { throw LocalMacAgentCuaSetupError.conflict }
        let name = ".cua-config-\(UUID().uuidString).tmp"
        let fd = openat(dir, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw LocalMacAgentCuaSetupError.conflict }; defer { close(fd); unlinkat(dir, name, 0) }
        let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
        guard written == bytes.count, fsync(fd) == 0,
              try LocalMacAgentPolicy.privateRead(location.configuration, maximum: 16384) == original,
              try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installationID) == expected else {
            throw LocalMacAgentCuaSetupError.conflict
        }
        var current = stat()
        guard lstat(location.root.path, &current) == 0, current.st_dev == opened.st_dev, current.st_ino == opened.st_ino,
              renameat(dir, name, dir, location.configuration.lastPathComponent) == 0, fsync(dir) == 0 else {
            throw LocalMacAgentCuaSetupError.outcomeUnknown
        }
    }
}
#endif
