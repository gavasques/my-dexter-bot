import Foundation

/// Bounded DER traversal for validity and explicit EKU; Security still evaluates SSL SAN/signature/trust.
enum CertificateProfile {
    enum Usage { case client, server }
    struct Node { let tag: UInt8; let body: Data }
    static func nodes(_ data: Data) throws -> [Node] {
        let bytes = [UInt8](data); var i = 0; var out: [Node] = []
        while i < bytes.count {
            guard out.count < 64, i + 2 <= bytes.count else { throw ClientIdentityFailure.invalidInput }
            let tag = bytes[i]; i += 1; let first = bytes[i]; i += 1; var n = Int(first)
            if first >= 128 {
                let count = Int(first & 127); guard count > 0, count <= 3, i + count <= bytes.count, bytes[i] != 0 else { throw ClientIdentityFailure.invalidInput }
                n = 0; for _ in 0..<count { n = (n << 8) | Int(bytes[i]); i += 1 }; guard n >= 128 else { throw ClientIdentityFailure.invalidInput }
            }
            guard n <= 16_384, i + n <= bytes.count else { throw ClientIdentityFailure.invalidInput }
            out.append(Node(tag:tag,body:Data(bytes[i..<i+n]))); i += n
        }
        return out
    }
    static func date(_ node: Node) throws -> Date {
        guard node.tag == 0x17 || node.tag == 0x18, let value = String(data:node.body,encoding:.ascii),
              value.utf8.count == (node.tag == 0x17 ? 13 : 15), value.last == "Z", value.dropLast().utf8.allSatisfy({(48...57).contains($0)}) else { throw ClientIdentityFailure.invalidInput }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier:"en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT:0)
        formatter.dateFormat = node.tag == 0x17 ? "yyMMddHHmmss'Z'" : "yyyyMMddHHmmss'Z'"
        formatter.isLenient = false; guard let date = formatter.date(from:value), formatter.string(from:date) == value else { throw ClientIdentityFailure.invalidInput }; return date
    }
    static func validate(_ der: Data, usage: Usage, now: Date) throws {
        guard der.count <= 16_384 else { throw ClientIdentityFailure.invalidInput }
        let root = try nodes(der); guard root.count == 1, root[0].tag == 0x30 else { throw ClientIdentityFailure.invalidInput }
        let cert = try nodes(root[0].body); guard cert.count == 3, cert[0].tag == 0x30 else { throw ClientIdentityFailure.invalidInput }
        let tbs = try nodes(cert[0].body); let offset = tbs.first?.tag == 0xa0 ? 1 : 0
        guard tbs.count > offset+5, tbs[offset+3].tag == 0x30 else { throw ClientIdentityFailure.invalidInput }
        let validity = try nodes(tbs[offset+3].body); guard validity.count == 2 else { throw ClientIdentityFailure.invalidInput }
        let start = try date(validity[0]), end = try date(validity[1]); guard now >= start, now <= end else { throw ClientIdentityFailure.expired }
        guard let extensions = tbs.first(where:{$0.tag == 0xa3}), let sequence = try nodes(extensions.body).first, sequence.tag == 0x30 else { throw ClientIdentityFailure.invalidInput }
        let ext = try nodes(sequence.body).map { try nodes($0.body) }
        let eku = ext.filter {$0.first?.tag == 6 && $0.first?.body == Data([0x55,0x1d,0x25])}
        guard eku.count == 1, let octet = eku[0].last, octet.tag == 4 else { throw ClientIdentityFailure.invalidInput }
        let value = try nodes(octet.body); guard value.count == 1, value[0].tag == 0x30 else { throw ClientIdentityFailure.invalidInput }
        let oid = Data([0x2b,0x06,0x01,0x05,0x05,0x07,0x03,usage == .server ? 1 : 2])
        guard try nodes(value[0].body).contains(where:{$0.tag == 6 && $0.body == oid}) else { throw ClientIdentityFailure.invalidInput }
    }
}
