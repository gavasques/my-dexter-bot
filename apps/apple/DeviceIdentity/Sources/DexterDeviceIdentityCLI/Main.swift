import Foundation
import Darwin
import DexterDeviceIdentity

private struct Config: Decodable {
    let installationID: String
    let laboratoryID: String?
    let hostURL: String?
    let hostCertificateDER: String?
    let hostFingerprint: String?
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
            let store = KeychainIdentityStorage(scope:scope), lifecycle = IdentityLifecycle(scope:scope,storage:store)
            let raw = try input(); try closed(raw,keys:["operation","route","bodyBase64","timeoutSeconds","expectedClientFingerprint"])
            let command = try JSONDecoder().decode(Command.self,from:raw)
            if command.operation == "remove-laboratory-items" { try await store.removeLaboratoryItems(); emit(["ok":true]); return }
            if command.operation == "request" {
                let result = try await PreparedDeviceRequest.execute(lifecycle:lifecycle,route:command.route,bodyBase64:command.bodyBase64,
                    hostURL:config.hostURL,hostCertificateDER:config.hostCertificateDER,hostFingerprint:config.hostFingerprint,
                    timeoutSeconds:command.timeoutSeconds,expectedClientFingerprint:command.expectedClientFingerprint)
                emit(["ok":true,"responseBase64":result.base64EncodedString()]); return
            }
            let identity: NativeIdentity
            switch command.operation {
            case "provision": identity = try await lifecycle.provisionExplicitly()
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
