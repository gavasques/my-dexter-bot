import Foundation
import Darwin
import Security

// LAB ONLY executable: no Keychain storage, provisioning, fallback or production mode.
private struct Config: Decodable {
    let installationID:String
    let laboratoryID:String?
    let hostURL:String?
    let hostCertificateDER:String?
    let hostFingerprint:String?
}
private struct LaboratoryMaterial:Decodable {
    let fixtureMarker:String
    let privateKeyX963:String
    let certificateDER:String
}
private struct PipeControl:Decodable { let holdOutputPipe:Bool }
private func inheritedPipe(_ fd:Int32,maximum:Int) throws -> Data {
    defer { close(fd) }
    var info=stat()
    guard fstat(fd,&info)==0,(info.st_mode&S_IFMT==S_IFIFO || info.st_mode&S_IFMT==S_IFSOCK) else { throw IdentityFailure.invalidInput }
    var bytes=Data(),buffer=[UInt8](repeating:0,count:4096)
    defer { _ = buffer.withUnsafeMutableBytes { $0.initializeMemory(as:UInt8.self,repeating:0) } }
    while true {
        let n=buffer.withUnsafeMutableBytes { read(fd,$0.baseAddress,$0.count) }
        if n<0 && errno==EINTR { continue }
        guard n>=0 else { throw IdentityFailure.unavailable }
        if n==0 { break }
        guard bytes.count+n<=maximum else { throw IdentityFailure.invalidInput }
        bytes.append(contentsOf:buffer.prefix(n))
    }
    guard !bytes.isEmpty else { throw IdentityFailure.invalidInput }
    return bytes
}
private actor LaboratoryStorage:IdentityStorage {
    let scope:IdentityScope
    let configPath:String
    private var cached:NativeIdentity?
    init(scope:IdentityScope,configPath:String) { self.scope=scope;self.configPath=configPath }
    func load(_ requested:IdentityScope) async throws -> NativeIdentity? {
        guard requested==scope,scope.laboratory else { throw IdentityFailure.invalidInput }
        if let cached { return cached }
        var bytes=try inheritedPipe(3,maximum:32768)
        defer { bytes.resetBytes(in:0..<bytes.count) }
        guard let object=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],Set(object.keys)==["fixtureMarker","privateKeyX963","certificateDER"] else { throw IdentityFailure.invalidInput }
        let material=try JSONDecoder().decode(LaboratoryMaterial.self,from:bytes)
        guard material.fixtureMarker=="dexter-native-client-laboratory-v1",
              var raw=Data(base64Encoded:material.privateKeyX963),raw.count==97,raw.first==4,raw.base64EncodedString()==material.privateKeyX963,
              let der=Data(base64Encoded:material.certificateDER),!der.isEmpty,der.count<=16384,der.base64EncodedString()==material.certificateDER,
              let certificate=SecCertificateCreateWithData(nil,der as CFData) else { throw IdentityFailure.invalidInput }
        defer { raw.resetBytes(in:0..<raw.count) }
        var failure:Unmanaged<CFError>?
        guard let key=SecKeyCreateWithData(raw as CFData,[kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeyClass:kSecAttrKeyClassPrivate,kSecAttrKeySizeInBits:256] as CFDictionary,&failure) else { throw IdentityFailure.invalidInput }
        let identity=try NativeIdentity(key:key,certificate:certificate,policy:"cli_forwarding_laboratory_memory_only")
        cached=identity;return identity
    }
    func startOwnedPipeFixture() async throws {
        let bytes=try inheritedPipe(4,maximum:512)
        guard let object=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],Set(object.keys)==["holdOutputPipe"] else { throw IdentityFailure.invalidInput }
        let control=try JSONDecoder().decode(PipeControl.self,from:bytes)
        guard control.holdOutputPipe else { return }
        let pidPath=configPath+".pipe-control.pid"
        let helper=URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("native-client-laboratory-pipe.py").path
        let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/python3")
        process.arguments=["-I",helper,pidPath];process.environment=[:]
        process.standardOutput=FileHandle.standardOutput;process.standardError=FileHandle.nullDevice
        try process.run()
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath:pidPath) { return }
            try await Task.sleep(for:.milliseconds(10))
        }
        if process.isRunning { process.terminate();process.waitUntilExit() }
        throw IdentityFailure.unavailable
    }
    func provision(_ requested:IdentityScope) async throws -> NativeIdentity { throw IdentityFailure.invalidInput }
}
private struct Command: Decodable {
    let operation: String
    let route: String?
    let bodyBase64: String?
    let timeoutSeconds: Double?
    let expectedClientFingerprint: String?
}
private func privateConfig(_ path: String) throws -> Data {
    guard path.hasPrefix("/"), let resolved = path.withCString({ realpath($0,nil) }) else { throw IdentityFailure.invalidInput }
    defer { free(resolved) }
    guard String(cString:resolved) == path else { throw IdentityFailure.invalidInput }
    let fd = open(path,O_RDONLY | O_NOFOLLOW); guard fd >= 0 else { throw IdentityFailure.unavailable }; defer { close(fd) }
    var info = stat(); guard fstat(fd,&info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_size <= 32768 else { throw IdentityFailure.invalidInput }
    var data = Data(count:Int(info.st_size)); let n = data.withUnsafeMutableBytes { read(fd,$0.baseAddress,Int(info.st_size)) }
    guard n == info.st_size else { throw IdentityFailure.unavailable }; return data
}
private func input() throws -> Data {
    var data = Data(); var chunk = [UInt8](repeating:0,count:4096)
    while true {
        let n = read(STDIN_FILENO,&chunk,chunk.count); guard n >= 0 else { throw IdentityFailure.unavailable }; if n == 0 { break }
        guard data.count+n <= 100_000 else { throw IdentityFailure.invalidInput }; data.append(contentsOf:chunk.prefix(n))
    }
    return data
}
private func closed(_ data:Data, keys:Set<String>) throws {
    guard let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any], Set(object.keys).isSubset(of:keys) else { throw IdentityFailure.invalidInput }
}
private func emit(_ object:[String:Any]) { if let data = try? JSONSerialization.data(withJSONObject:object,options:[.sortedKeys]) { FileHandle.standardOutput.write(data+Data([10])) } }
@main struct Main {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count == 3, args[1] == "--config" else { throw IdentityFailure.invalidInput }
            let bytes = try privateConfig(args[2]); try closed(bytes,keys:["installationID","laboratoryID","hostURL","hostCertificateDER","hostFingerprint"])
            let config = try JSONDecoder().decode(Config.self,from:bytes)
            let scope = try IdentityScope(installationID:config.installationID,laboratoryID:config.laboratoryID)
            guard scope.laboratory else { throw IdentityFailure.invalidInput }
            let storage = LaboratoryStorage(scope:scope,configPath:args[2])
            let lifecycle = IdentityLifecycle(scope:scope,storage:storage)
            let raw = try input(); try closed(raw,keys:["operation","route","bodyBase64","timeoutSeconds","expectedClientFingerprint"])
            let command = try JSONDecoder().decode(Command.self,from:raw)
            if command.operation == "request" {
                try await storage.startOwnedPipeFixture()
                let result = try await PreparedDeviceRequest.execute(lifecycle:lifecycle,route:command.route,bodyBase64:command.bodyBase64,
                    hostURL:config.hostURL,hostCertificateDER:config.hostCertificateDER,hostFingerprint:config.hostFingerprint,
                    timeoutSeconds:command.timeoutSeconds,expectedClientFingerprint:command.expectedClientFingerprint)
                emit(["ok":true,"responseBase64":result.base64EncodedString()]); return
            }
            let identity: NativeIdentity
            switch command.operation {
            case "load": identity = try await lifecycle.loadOnly()
            default: throw IdentityFailure.invalidInput
            }
            emit(["ok":true,"certificateDER":identity.certificateDER.base64EncodedString(),"fingerprint":identity.fingerprint,"policy":identity.policy])
        } catch let failure as RemoteDeviceFailure { emit(["ok":false,"error":failure.rawValue]); exit(1) }
        catch let failure as IdentityFailure { emit(["ok":false,"error":failure.rawValue]); exit(1) }
        catch is DecodingError { emit(["ok":false,"error":"invalidInput"]); exit(1) }
        catch { emit(["ok":false,"error":"unavailable"]); exit(1) }
    }
}
