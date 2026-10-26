// TEST ONLY replacement module storage for compiling the unchanged official CLI source.
// This symbol must never ship. No SecItem query/provision/remove API is called.
import Foundation
import Security
import Darwin
private struct ForwardingMaterial:Decodable {
    let fixtureMarker:String
    let privateKeyX963:String
    let certificateDER:String
}
private func fixturePath() throws -> String {
    let args=CommandLine.arguments
    guard args.count==3,args[1]=="--config",args[2].hasPrefix("/") else { throw IdentityFailure.invalidInput }
    return args[2]+".memory-fixture"
}
// The private material is inherited on descriptor 3; regular files are refused.
private func fixtureBytes() throws -> Data {
    let fd:Int32=3
    var info=stat()
    guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFIFO || info.st_mode&S_IFMT==S_IFSOCK else {throw IdentityFailure.invalidInput}
    var result=Data(),buffer=[UInt8](repeating:0,count:4096)
    defer{_ = buffer.withUnsafeMutableBytes{ $0.initializeMemory(as:UInt8.self,repeating:0) }}
    while true {
        let n=buffer.withUnsafeMutableBytes{read(fd,$0.baseAddress,$0.count)}
        guard n>=0 else {throw IdentityFailure.unavailable}
        if n==0 {break}
        guard result.count+n<=32768 else {throw IdentityFailure.invalidInput}
        result.append(contentsOf:buffer.prefix(n))
    }
    guard !result.isEmpty else {throw IdentityFailure.invalidInput}
    return result
}
private func count(_ operation:String) throws {
    let path=try fixturePath()+".counts"
    let fd=open(path,O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW,0o600);guard fd>=0 else {throw IdentityFailure.unavailable};defer{close(fd)}
    var info=stat();guard fstat(fd,&info)==0,info.st_mode&S_IFMT==S_IFREG,info.st_uid==getuid(),info.st_mode&0o077==0,info.st_size<4096 else {throw IdentityFailure.invalidInput}
    let bytes=Array((operation+"\n").utf8);let written=bytes.withUnsafeBytes{write(fd,$0.baseAddress,$0.count)};guard written==bytes.count else {throw IdentityFailure.unavailable}
}
public actor KeychainIdentityStorage:IdentityStorage {
    private let scope:IdentityScope
    private var cached:Data?
    public init(scope:IdentityScope){self.scope=scope}
    public func load(_ requested:IdentityScope) async throws -> NativeIdentity? {
        guard requested==scope,scope.laboratory else {throw IdentityFailure.invalidInput}
        try count("load")
        let bytes:Data
        if let cached {bytes=cached} else {let input=try fixtureBytes();cached=input;bytes=input}
        guard let object=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],Set(object.keys)==["fixtureMarker","privateKeyX963","certificateDER"] else {throw IdentityFailure.invalidInput}
        let material=try JSONDecoder().decode(ForwardingMaterial.self,from:bytes)
        guard material.fixtureMarker=="dexter-native-cli-forwarding-laboratory-v1",let raw=Data(base64Encoded:material.privateKeyX963),raw.count==97,let der=Data(base64Encoded:material.certificateDER),der.count<=16384,let certificate=SecCertificateCreateWithData(nil,der as CFData) else {throw IdentityFailure.invalidInput}
        var error:Unmanaged<CFError>?
        guard let key=SecKeyCreateWithData(raw as CFData,[kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeyClass:kSecAttrKeyClassPrivate,kSecAttrKeySizeInBits:256] as CFDictionary,&error) else {throw IdentityFailure.invalidInput}
        return try NativeIdentity(key:key,certificate:certificate,policy:"cli_forwarding_laboratory_memory_only")
    }
    public func provision(_ requested:IdentityScope) async throws -> NativeIdentity {try count("provision");throw IdentityFailure.invalidInput}
    public func removeLaboratoryItems() async throws {throw IdentityFailure.invalidInput}
}
