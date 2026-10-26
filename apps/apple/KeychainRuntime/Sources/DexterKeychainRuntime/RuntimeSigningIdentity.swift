#if os(macOS)
import Foundation
import Security

/// Public metadata of THIS runtime executable only. No identity/cert/profile/account enumeration.
public struct RuntimeSigningIdentity: Equatable, Sendable {
    public let validityStatus: Int32
    public let bundleIdentifier: String?
    public let codeIdentifier: String?
    public let teamIdentifier: String?
    public let applicationIdentifier: String?
    public let accessGroups: [String]
    public init(validityStatus:Int32,bundleIdentifier:String?,codeIdentifier:String?,teamIdentifier:String?,applicationIdentifier:String?,accessGroups:[String]) {
        self.validityStatus=validityStatus;self.bundleIdentifier=bundleIdentifier;self.codeIdentifier=codeIdentifier;self.teamIdentifier=teamIdentifier;self.applicationIdentifier=applicationIdentifier;self.accessGroups=accessGroups
    }
    public enum Refusal: String, Error, Equatable, Sendable {
        case invalidRuntimeSignature, unboundHelperBundle, missingAuthorizedSigningIdentity, missingApplicationIdentifier, invalidAccessGroup
    }
    /// Identifies a signed namespace; actual Security APIs still decide entitlement authorization.
    /// Ad-hoc/local App-ID claims are deliberately not a substitute for an authorized Team signature.
    public func exactDataProtectionAccessGroup() throws -> String {
        guard validityStatus==errSecSuccess else { throw Refusal.invalidRuntimeSignature }
        guard let bundleIdentifier,Self.validID(bundleIdentifier),codeIdentifier==bundleIdentifier else { throw Refusal.unboundHelperBundle }
        guard let teamIdentifier,!teamIdentifier.isEmpty,teamIdentifier.range(of:"^[A-Z0-9]{10}$",options:.regularExpression) != nil else { throw Refusal.missingAuthorizedSigningIdentity }
        guard let applicationIdentifier,Self.validID(applicationIdentifier),applicationIdentifier.hasSuffix("."+bundleIdentifier) else { throw Refusal.missingApplicationIdentifier }
        // The default group is the first explicitly entitled group, otherwise the app identifier. Never a wildcard search.
        let group=accessGroups.first ?? applicationIdentifier
        guard Self.validID(group),accessGroups.allSatisfy(Self.validID),Set(accessGroups).count==accessGroups.count else { throw Refusal.invalidAccessGroup }
        return group
    }
    private static func validID(_ value:String)->Bool { !value.isEmpty && value.utf8.count<=256 && value.range(of:"^[A-Za-z0-9][A-Za-z0-9.-]*$",options:.regularExpression) != nil && !value.contains("..") }
    public static func current() -> Self {
        var code:SecCode?,staticCode:SecStaticCode?,raw:CFDictionary?
        var validity=SecCodeCopySelf([], &code)
        if validity==errSecSuccess,let code {
            validity=SecCodeCheckValidity(code,[],nil)
            if SecCodeCopyStaticCode(code,[],&staticCode)==errSecSuccess,let staticCode {
                _=SecCodeCopySigningInformation(staticCode,SecCSFlags(rawValue:kSecCSSigningInformation),&raw)
            }
        }
        let info=(raw as? [String:Any]) ?? [:],ent=(info[kSecCodeInfoEntitlementsDict as String] as? [String:Any]) ?? [:]
        return Self(validityStatus:validity,bundleIdentifier:Bundle.main.bundleIdentifier,codeIdentifier:info[kSecCodeInfoIdentifier as String] as? String,
            teamIdentifier:info[kSecCodeInfoTeamIdentifier as String] as? String,applicationIdentifier:ent["com.apple.application-identifier"] as? String,
            accessGroups:ent["keychain-access-groups"] as? [String] ?? [])
    }
}
#endif
