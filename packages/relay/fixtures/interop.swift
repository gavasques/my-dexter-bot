// Synthetic interoperability fixture, not an app or transport. Private keys never leave this process.
import Foundation
import CryptoKit

enum FixtureError: Error { case invalid }
func canonical(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
}
func emit(_ value: [String: Any]) throws {
    let data = try canonical(value)
    FileHandle.standardOutput.write(data + Data([10]))
}
func b64(_ value: Any?) throws -> Data {
    guard let value = value as? String, let data = Data(base64Encoded: value) else { throw FixtureError.invalid }
    return data
}
func spki(_ raw: Data, signing: Bool) -> Data {
    Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65, signing ? 0x70 : 0x6e,0x03,0x21,0x00]) + raw
}
let headerKeys = ["version","installationId","ownerId","messageId","senderId","senderGeneration","senderKeyId","recipientId","recipientGeneration","recipientKeyId","type","sequence","createdAt","expiresAt","ephemeralPublicKey","nonce"]
func aad(_ e: [String: Any]) throws -> Data {
    try canonical(headerKeys.map { e[$0] ?? NSNull() })
}
func signed(_ e: [String: Any]) throws -> Data {
    try Data("DEXTER_RELAY_ENVELOPE_V1\n".utf8) + aad(e) + Data([10]) + canonical([e["ciphertext"]!,e["tag"]!])
}
func key(_ secret: SharedSecret, aad: Data, installation: String) -> SymmetricKey {
    let salt = Data(SHA256.hash(data: Data(("DEXTER_RELAY_KDF_V1\n" + installation).utf8)))
    return secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt,
        sharedInfo: Data("DEXTER_RELAY_AEAD_V1\n".utf8) + aad, outputByteCount: 32)
}

do {
    let signing = Curve25519.Signing.PrivateKey(), encryption = Curve25519.KeyAgreement.PrivateKey()
    try emit(["ownerId":"synthetic-owner","installationId":"synthetic-host","deviceId":"swift-peer","generation":1,"keyId":"swift-peer-key-1",
              "signingPublicKey":spki(signing.publicKey.rawRepresentation, signing:true).base64EncodedString(),
              "encryptionPublicKey":spki(encryption.publicKey.rawRepresentation, signing:false).base64EncodedString()])
    guard let line = readLine(), let data = line.data(using:.utf8),
          let input = try JSONSerialization.jsonObject(with:data) as? [String:Any],
          let e = input["envelope"] as? [String:Any], let sender = input["nodePin"] as? [String:Any],
          let ackItem = input["ackItem"] as? [String:Any],
          let installation = e["installationId"] as? String else { throw FixtureError.invalid }
    let publicSigning = try Curve25519.Signing.PublicKey(rawRepresentation: b64(sender["signingPublicKey"]).suffix(32))
    guard try publicSigning.isValidSignature(b64(e["signature"]), for:signed(e)) else { throw FixtureError.invalid }
    let ephemeralPublic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation:b64(e["ephemeralPublicKey"]).suffix(32))
    let secret = try encryption.sharedSecretFromKeyAgreement(with:ephemeralPublic)
    let nodeAAD = try aad(e), derived = key(secret, aad:nodeAAD, installation:installation)
    let sealed = try AES.GCM.SealedBox(nonce:AES.GCM.Nonce(data:b64(e["nonce"])), ciphertext:b64(e["ciphertext"]), tag:b64(e["tag"]))
    let plaintext = try AES.GCM.open(sealed, using:derived, authenticating:nodeAAD)
    let recipientPublic = try Curve25519.KeyAgreement.PublicKey(rawRepresentation:b64(sender["encryptionPublicKey"]).suffix(32))
    let ephemeral = Curve25519.KeyAgreement.PrivateKey(), nonce = AES.GCM.Nonce()
    var response: [String:Any] = ["version":1,"installationId":installation,"ownerId":"synthetic-owner","messageId":"swift-response",
      "senderId":"swift-peer","senderGeneration":1,"senderKeyId":"swift-peer-key-1","recipientId":sender["deviceId"]!,
      "recipientGeneration":sender["generation"]!,"recipientKeyId":sender["keyId"]!,"type":"event","sequence":1,
      "createdAt":e["createdAt"]!,"expiresAt":e["expiresAt"]!,"ephemeralPublicKey":spki(ephemeral.publicKey.rawRepresentation,signing:false).base64EncodedString(),
      "nonce":nonce.withUnsafeBytes { Data($0).base64EncodedString() }]
    let swiftAAD = try aad(response), swiftSecret = try ephemeral.sharedSecretFromKeyAgreement(with:recipientPublic)
    let encrypted = try AES.GCM.seal(plaintext, using:key(swiftSecret,aad:swiftAAD,installation:installation), nonce:nonce, authenticating:swiftAAD)
    response["ciphertext"] = encrypted.ciphertext.base64EncodedString(); response["tag"] = encrypted.tag.base64EncodedString()
    let authenticated = try signed(response), sig1 = try signing.signature(for:authenticated), sig2 = try signing.signature(for:authenticated)
    response["signature"] = sig1.base64EncodedString()
    var ack: [String:Any] = ["version":1,"kind":"ack","installationId":installation,"ownerId":"synthetic-owner","deviceId":"swift-peer",
      "generation":1,"keyId":"swift-peer-key-1","requestId":"swift-ack","issuedAt":e["createdAt"]!,"messages":[ackItem]]
    let control = try Data("DEXTER_RELAY_CONTROL_V1\n".utf8) + canonical([1,"ack",installation,"synthetic-owner","swift-peer",1,"swift-peer-key-1","swift-ack",e["createdAt"]!,[[ackItem["messageId"]!,ackItem["receiptId"]!]]])
    ack["signature"] = try signing.signature(for:control).base64EncodedString()
    let ackSecond = try signing.signature(for:control).base64EncodedString()
    try emit(["envelope":response,"nodeAADBase64":nodeAAD.base64EncodedString(),"swiftAADBase64":swiftAAD.base64EncodedString(),
              "repeatedSignaturesEqual":sig1 == sig2,
              "secondSignature":sig2.base64EncodedString(),
              "ack":ack,"ackSecondSignature":ackSecond,"controlBytesBase64":control.base64EncodedString(),
              "plaintextDigest":SHA256.hash(data:plaintext).map { String(format:"%02x",$0) }.joined()])
} catch {
    // Never print raw crypto errors, keys or plaintext.
    FileHandle.standardError.write(Data("synthetic interop failed\n".utf8))
    exit(1)
}
