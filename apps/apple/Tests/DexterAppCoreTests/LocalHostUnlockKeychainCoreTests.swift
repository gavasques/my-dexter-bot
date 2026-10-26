#if os(macOS)
import Foundation
import Darwin
import XCTest
import Security
import DexterKeychainRuntime
@testable import DexterAppCore

@MainActor private final class SyntheticUnlockBackend: LocalHostUnlockKeychainBackend {
    var values: [String: [CFString: Any]] = [:]
    var queries: [LocalHostUnlockQuery] = []; var insertions = 0
    var failure: LocalHostUnlockFailure?
    var mutateDuringInsert: (() throws -> Void)?
    func lookup(_ query: LocalHostUnlockQuery) throws -> [CFString: Any]? {
        queries.append(query); if let failure { throw failure }
        guard var value = values[query.scope.keychainService] else { return nil }
        if !query.returnsValue { value.removeValue(forKey: kSecValueData) }
        return value
    }
    func insert(_ query: LocalHostUnlockQuery, bytes: Data) throws {
        if let failure { throw failure }
        guard values[query.scope.keychainService] == nil else { throw LocalHostUnlockFailure.alreadyExists }
        var value = try LocalHostUnlockAttributes.creation(scope: query.scope, accessGroup: query.accessGroup, creationId: query.creationId)
        value[kSecValueData] = bytes; values[query.scope.keychainService] = value; insertions += 1
        try mutateDuringInsert?()
    }
}
@MainActor final class LocalHostUnlockKeychainCoreTests: XCTestCase {
    private let bundleID = "bot.dexter.synthetic.unlock"
    private func signed(_ bundle: String? = nil) -> RuntimeSigningIdentity {
        let bundle = bundle ?? bundleID
        return .init(validityStatus: 0, bundleIdentifier: bundle, codeIdentifier: bundle, teamIdentifier: "ABCDE12345",
            applicationIdentifier: "ABCDE12345." + bundle, accessGroups: ["ABCDE12345." + bundle])
    }
    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("qa/unlock-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]); return root
    }
    private func scope(_ root: URL, filename: String = "local-device.sealed", bundle: String? = nil) throws -> LocalHostUnlockScope {
        try .init(bundleID: bundle ?? bundleID, custodyFilePath: root.appendingPathComponent(filename).path)
    }
    private func sealed(_ scope: LocalHostUnlockScope) throws {
        try Data("OWN SYNTHETIC CIPHERTEXT FIXTURE".utf8).write(to: URL(fileURLWithPath: scope.custodyFilePath)); _ = chmod(scope.custodyFilePath, 0o600)
    }
    private func store(_ backend: SyntheticUnlockBackend, identity: RuntimeSigningIdentity? = nil) -> NativeLocalHostUnlockStore {
        let identity = identity ?? signed()
        return .init(runtimeIdentity: { identity }, backend: backend, random: { Data(repeating: 0x5a, count: 32) })
    }
    func testNamespaceIsDedicatedBundleAndCanonicalFileAndRejectsAliases() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let one = try scope(root), two = try scope(root, filename: "another.sealed"), three = try scope(root, bundle: "bot.dexter.other")
        XCTAssertNotEqual(one.keychainService, two.keychainService); XCTAssertNotEqual(one.keychainService, three.keychainService)
        XCTAssertTrue(one.keychainService.hasPrefix("com.dexter.local-host-unlock.v1.bundle.")); XCTAssertFalse(one.keychainService.contains(root.path))
        XCTAssertThrowsError(try LocalHostUnlockScope(bundleID: "bad..bundle", custodyFilePath: one.custodyFilePath))
        XCTAssertThrowsError(try LocalHostUnlockScope(bundleID: bundleID, custodyFilePath: root.path + "/../alias"))
        let linked = root.appendingPathComponent("linked"); try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: root)
        XCTAssertThrowsError(try LocalHostUnlockScope(bundleID: bundleID, custodyFilePath: linked.appendingPathComponent("secret.sealed").path))
    }
    func testPureAttributesUseExactDataProtectionGroupDeviceOnlyAndNoEnumeration() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root)
        let query = LocalHostUnlockAttributes.query(scope: address, accessGroup: "ABCDE12345." + bundleID, returnsValue: false)
        XCTAssertEqual(query[kSecClass] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrService] as? String, address.keychainService); XCTAssertEqual(query[kSecAttrAccount] as? String, LocalHostUnlockScope.keychainAccount)
        XCTAssertEqual(query[kSecUseDataProtectionKeychain] as? Bool, true); XCTAssertEqual(query[kSecAttrSynchronizable] as? Bool, false)
        XCTAssertEqual(query[kSecMatchLimit] as? String, kSecMatchLimitOne as String); XCTAssertNil(query[kSecReturnData])
        let create = try LocalHostUnlockAttributes.creation(scope: address, accessGroup: "ABCDE12345." + bundleID)
        XCTAssertEqual(create[kSecAttrAccessible] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertNil(create[kSecValueData]); XCTAssertNil(create[kSecAttrAccessControl])
    }
    func testCreateOnlyAndSilentLoadAndRelaunchRequireCiphertextToExist() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root), backend = SyntheticUnlockBackend(), native = store(backend)
        XCTAssertEqual(native.status(scope: address), .missing); XCTAssertEqual(backend.insertions, 0)
        let created = try native.create(scope: address); XCTAssertTrue(created.hasValue)
        XCTAssertEqual(try created.consume { $0.count }, 32); XCTAssertFalse(created.hasValue)
        XCTAssertEqual(native.status(scope: address), .blocked)
        XCTAssertThrowsError(try native.load(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .conflict) }
        XCTAssertThrowsError(try native.create(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .alreadyExists) }
        try sealed(address); let relaunch = store(backend)
        XCTAssertEqual(relaunch.status(scope: address), .configured)
        let value = try relaunch.load(scope: address); XCTAssertEqual(try value.consume { Array($0) }, [UInt8](repeating: 0x5a, count: 32))
        let reads = backend.queries.filter { $0.returnsValue }; XCTAssertEqual(reads.count, 1); XCTAssertTrue(reads.allSatisfy(\.interactionNotAllowed))
        XCTAssertEqual(backend.insertions, 1)
    }
    func testExistingCiphertextWithoutItemIsLegacyAndNeverGeneratesNewSecret() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root); try sealed(address)
        let backend = SyntheticUnlockBackend(); let identity = signed(); var randomCalls = 0
        let native = NativeLocalHostUnlockStore(runtimeIdentity: { identity }, backend: backend, random: { randomCalls += 1; return Data(repeating: 7, count: 32) })
        XCTAssertEqual(native.status(scope: address), .legacyPasswordRequired)
        XCTAssertThrowsError(try native.create(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .legacyPasswordRequired) }
        XCTAssertThrowsError(try native.load(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .legacyPasswordRequired) }
        XCTAssertEqual(randomCalls, 0); XCTAssertEqual(backend.insertions, 0)
    }
    func testUnsignedAndForeignBundleFailBeforeBackendAndRandom() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root)
        let backend = SyntheticUnlockBackend(); var randomCalls = 0
        let unsigned = RuntimeSigningIdentity(validityStatus: -67062, bundleIdentifier: bundleID, codeIdentifier: bundleID, teamIdentifier: nil, applicationIdentifier: nil, accessGroups: [])
        let native = NativeLocalHostUnlockStore(runtimeIdentity: { unsigned }, backend: backend, random: { randomCalls += 1; return Data(repeating: 9, count: 32) })
        XCTAssertEqual(native.status(scope: address), .blocked)
        XCTAssertThrowsError(try native.create(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .signingIdentityUnavailable) }
        XCTAssertThrowsError(try native.load(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .signingIdentityUnavailable) }
        let foreign = store(backend, identity: signed("bot.dexter.other"))
        XCTAssertThrowsError(try foreign.create(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .scopeMismatch) }
        XCTAssertTrue(backend.queries.isEmpty); XCTAssertEqual(backend.insertions, 0); XCTAssertEqual(randomCalls, 0)
    }
    func testAttributesAndLockedItemNeverFallbackOrRegenerate() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root), backend = SyntheticUnlockBackend(), native = store(backend)
        let created = try native.create(scope: address); created.clear(); try sealed(address)
        for key in [kSecAttrService, kSecAttrAccount, kSecAttrAccessGroup, kSecAttrAccessible] {
            let original = backend.values[address.keychainService]![key]
            backend.values[address.keychainService]![key] = "foreign-value"
            XCTAssertEqual(native.status(scope: address), .blocked); XCTAssertThrowsError(try native.load(scope: address))
            backend.values[address.keychainService]![key] = original
        }
        backend.values[address.keychainService]![kSecAttrSynchronizable] = true
        XCTAssertThrowsError(try native.load(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .conflict) }
        backend.values[address.keychainService]![kSecAttrSynchronizable] = false
        backend.failure = .locked
        XCTAssertEqual(native.status(scope: address), .blocked)
        XCTAssertThrowsError(try native.load(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .locked) }
        XCTAssertEqual(backend.insertions, 1)
    }
    func testOwnedBufferIsRedactedClearedAndConsumedOnceEvenWhenClosureThrows() throws {
        let value = try XCTUnwrap(OwnedLocalHostUnlockBytes(bytes: Data(repeating: 0x51, count: 32)))
        XCTAssertEqual(String(describing: value), "OwnedLocalHostUnlockBytes(redacted)")
        XCTAssertEqual(String(reflecting: value), "OwnedLocalHostUnlockBytes(redacted)")
        XCTAssertEqual(Mirror(reflecting: value).children.count, 1)
        XCTAssertThrowsError(try value.consume { _ -> Int in throw LocalHostUnlockFailure.unavailable })
        XCTAssertFalse(value.hasValue); XCTAssertTrue(value.clearedStorageIsZero)
        XCTAssertThrowsError(try value.consume { $0.count }) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .consumed) }
        value.clear(); XCTAssertFalse(value.hasValue); XCTAssertNil(OwnedLocalHostUnlockBytes(bytes: Data(count: 31)))
    }
    func testFileRaceAfterCreateIsUnknownAndKeepsItemWithoutUpdatingOrDeleting() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root), backend = SyntheticUnlockBackend(), native = store(backend)
        backend.mutateDuringInsert = { try self.sealed(address) }
        XCTAssertThrowsError(try native.create(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .outcomeUnknown) }
        XCTAssertEqual(backend.insertions, 1); XCTAssertNotNil(backend.values[address.keychainService])
        XCTAssertThrowsError(try native.create(scope: address)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .alreadyExists) }
    }
    func testScopeIsolationCannotLoadAnotherFileOrBundleAndReturnsNoValueFromStatus() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let one = try scope(root), two = try scope(root, filename: "other.sealed")
        let backend = SyntheticUnlockBackend(), native = store(backend); let bytes = try native.create(scope: one); bytes.clear(); try sealed(one); try sealed(two)
        XCTAssertEqual(native.status(scope: one), .configured); XCTAssertEqual(native.status(scope: two), .legacyPasswordRequired)
        XCTAssertThrowsError(try native.load(scope: two)); XCTAssertEqual(backend.insertions, 1)
        XCTAssertTrue(backend.queries.filter { !$0.returnsValue }.allSatisfy { $0.interactionNotAllowed || $0.scope == one })
    }
    func testHumanResumeReadsSamePendingSecretOnlyUnderExactOriginalCreationId() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root), backend = SyntheticUnlockBackend(), native = store(backend)
        let id = UUID().uuidString, created = try native.create(scope: address, creationId: id)
        XCTAssertEqual(created.creationId, id.lowercased()); let original = try created.consume { Array($0) }
        XCTAssertEqual(native.status(scope: address), .blocked)
        XCTAssertThrowsError(try native.load(scope: address))
        let info = try XCTUnwrap(native.creationInfo(scope: address)); XCTAssertEqual(info.creationId, id.lowercased())
        let valueReadsBefore = backend.queries.filter(\.returnsValue).count
        XCTAssertThrowsError(try native.loadPendingCreation(scope: address, expectedCreationId: UUID().uuidString)) { XCTAssertEqual($0 as? LocalHostUnlockFailure, .conflict) }
        XCTAssertEqual(backend.queries.filter(\.returnsValue).count, valueReadsBefore)
        let resumed = try native.loadPendingCreation(scope: address, expectedCreationId: info.creationId)
        XCTAssertEqual(try resumed.consume { Array($0) }, original); XCTAssertEqual(backend.insertions, 1)
        XCTAssertTrue(backend.queries.filter(\.returnsValue).allSatisfy(\.interactionNotAllowed))
        try sealed(address)
        XCTAssertThrowsError(try native.loadPendingCreation(scope: address, expectedCreationId: info.creationId))
        XCTAssertEqual(native.status(scope: address), .configured)
    }
    func testUnsafeCiphertextMetadataBlocksBeforeAnySecretValueRead() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root), backend = SyntheticUnlockBackend(), native = store(backend)
        let created = try native.create(scope: address); created.clear(); try sealed(address)
        XCTAssertEqual(chmod(address.custodyFilePath, 0o644), 0)
        XCTAssertEqual(native.status(scope: address), .blocked); XCTAssertThrowsError(try native.load(scope: address))
        XCTAssertEqual(chmod(address.custodyFilePath, 0o600), 0)
        let descriptor = open(address.custodyFilePath, O_WRONLY | O_NOFOLLOW); XCTAssertGreaterThanOrEqual(descriptor, 0)
        guard descriptor >= 0 else { return }; defer { close(descriptor) }
        XCTAssertEqual(ftruncate(descriptor, 8 * 1024 * 1024 + 1), 0)
        XCTAssertEqual(native.status(scope: address), .blocked); XCTAssertThrowsError(try native.load(scope: address))
        XCTAssertEqual(ftruncate(descriptor, 0), 0)
        XCTAssertEqual(native.status(scope: address), .blocked); XCTAssertThrowsError(try native.load(scope: address))
        try sealed(address)
        let alias = root.appendingPathComponent("hardlink").path
        XCTAssertEqual(link(address.custodyFilePath, alias), 0)
        XCTAssertEqual(native.status(scope: address), .blocked); XCTAssertThrowsError(try native.load(scope: address))
        XCTAssertTrue(backend.queries.allSatisfy { !$0.returnsValue }); XCTAssertEqual(backend.insertions, 1)
    }
    func testCreationMetadataCannotBeMovedAcrossScopeOrTamperedForHumanResume() throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }; let address = try scope(root), other = try scope(root, filename: "other.sealed"), backend = SyntheticUnlockBackend(), native = store(backend)
        let id = UUID().uuidString; let created = try native.create(scope: address, creationId: id); created.clear()
        backend.values[address.keychainService]![kSecAttrGeneric] = try LocalHostUnlockAttributes.creationMetadata(scope: other, creationId: id)
        XCTAssertEqual(native.status(scope: address), .blocked)
        XCTAssertThrowsError(try native.creationInfo(scope: address))
        XCTAssertThrowsError(try native.loadPendingCreation(scope: address, expectedCreationId: id))
        XCTAssertTrue(backend.queries.allSatisfy { !$0.returnsValue }); XCTAssertEqual(backend.insertions, 1)
    }
}
#endif
