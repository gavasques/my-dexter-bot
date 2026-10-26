import Foundation
import Security
import CryptoKit

/// Fixed X.509 v3 P-256 ECDSA-SHA256 self-signed clientAuth leaf. No general CSR/issuer engine API.
enum ClientCertificate {
    static func tlv(_ tag: UInt8, _ body: Data) -> Data {
        let count = body.count
        var length = Data()
        if count < 128 { length.append(UInt8(count)) }
        else { var n = count, bytes: [UInt8] = []; while n > 0 { bytes.insert(UInt8(n & 255), at: 0); n >>= 8 }; length.append(0x80 | UInt8(bytes.count)); length.append(contentsOf: bytes) }
        return Data([tag]) + length + body
    }
    static func sequence(_ data: Data...) -> Data { tlv(0x30, data.reduce(Data(), +)) }
    static func oid(_ bytes: [UInt8]) -> Data { tlv(0x06, Data(bytes)) }
    static let signatureAlgorithm = sequence(oid([0x2a,0x86,0x48,0xce,0x3d,0x04,0x03,0x02]))
    static func name(_ label: String) -> Data { sequence(tlv(0x31, sequence(oid([0x55,0x04,0x03]), tlv(0x0c, Data(label.utf8))))) }
    static func time(_ date: Date) throws -> Data {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let year = calendar.component(.year, from: date)
        guard year >= 1970 && year <= 2099 else { throw IdentityFailure.invalidInput }
        formatter.dateFormat = year < 2050 ? "yyMMddHHmmss'Z'" : "yyyyMMddHHmmss'Z'"
        return tlv(year < 2050 ? 0x17 : 0x18, Data(formatter.string(from: date).utf8))
    }
    static func ext(_ oidBytes: [UInt8], _ body: Data, critical: Bool = false) -> Data {
        sequence(oid(oidBytes), critical ? tlv(1, Data([0xff])) : Data(), tlv(4, body))
    }
    static func make(key: SecKey, label: String, now: Date) throws -> SecCertificate {
        guard label.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil,
              let publicKey = SecKeyCopyPublicKey(key) else { throw IdentityFailure.invalidInput }
        var error: Unmanaged<CFError>?
        guard let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?, raw.count == 65, raw.first == 4 else { throw IdentityFailure.unavailable }
        let publicInfo = sequence(sequence(oid([0x2a,0x86,0x48,0xce,0x3d,0x02,0x01]),oid([0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07])),tlv(3,Data([0])+raw))
        var serial = Data(count: 20)
        let randomStatus = serial.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 20, $0.baseAddress!) }
        guard randomStatus == errSecSuccess else { throw IdentityFailure.unavailable }
        serial[0] &= 0x7f; if serial[0] == 0 { serial[0] = 1 }
        let subject = name(label)
        let ski = Data(Insecure.SHA1.hash(data: raw))
        let extensions = sequence(
            ext([0x55,0x1d,0x13],sequence(),critical:true),
            ext([0x55,0x1d,0x0f],tlv(3,Data([7,0x80])),critical:true),
            ext([0x55,0x1d,0x25],sequence(oid([0x2b,0x06,0x01,0x05,0x05,0x07,0x03,0x02]))),
            ext([0x55,0x1d,0x0e],tlv(4,ski)), ext([0x55,0x1d,0x23],sequence(tlv(0x80,ski)))
        )
        let tbs = sequence(tlv(0xa0,tlv(2,Data([2]))),tlv(2,serial),signatureAlgorithm,subject,
            sequence(try time(now.addingTimeInterval(-60)),try time(now.addingTimeInterval(365*86400))),subject,publicInfo,tlv(0xa3,extensions))
        guard let signature = SecKeyCreateSignature(key,.ecdsaSignatureMessageX962SHA256,tbs as CFData,&error) as Data?,
              let certificate = SecCertificateCreateWithData(nil,sequence(tbs,signatureAlgorithm,tlv(3,Data([0])+signature)) as CFData) else { throw IdentityFailure.unavailable }
        return certificate
    }
}
