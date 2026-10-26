import Security
import Network

/// One application path for the protocol settings, with injectable setters for deterministic policy tests.
/// Production supplies the Network/Security setters; no caller-selected policy is exposed publicly.
enum TransportSecurityPolicy {
    static func configureProtocol(minimum:(tls_protocol_version_t)->Void,maximum:(tls_protocol_version_t)->Void,
        resumption:(Bool)->Void,tickets:(Bool)->Void,falseStart:(Bool)->Void) {
        minimum(.TLSv13); maximum(.TLSv13); resumption(false); tickets(false); falseStart(false)
    }
    static func configureTrust(anchorOnly:(Bool)->OSStatus,networkFetch:(Bool)->OSStatus) -> Bool {
        anchorOnly(true) == errSecSuccess && networkFetch(false) == errSecSuccess
    }
}
