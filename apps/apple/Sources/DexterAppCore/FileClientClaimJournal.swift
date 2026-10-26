import Foundation
import Darwin
import DexterClientIdentity

/// Durable code-free claim metadata. OS lock covers read/compare/write across processes.
/// Corrupt archives stay in place as a fail-closed barrier; a bounded quarantine copy is diagnostic.
/// Additional SDK admission barrier: uncertain claims hold the whole installation+role.
/// It is checked before identity provisioning or importing a replacement namespace/pin.
public enum ClaimJournalAdmissionError: Error, Equatable, Sendable { case capacity, busy, durability }

public protocol PairedClientClaimJournal: ClientClaimJournal {
    func assertNoUnknownClaim(installationID: String, role: ClientRole) throws
    func statusAndResolve(_ session: ClientPairingSession) async throws -> ClientPairingStatus
    func mayDiscardReference(_ reference: PairedHostReference) throws -> Bool
}
public extension PairedClientClaimJournal {
    func statusAndResolve(_ session: ClientPairingSession) async throws -> ClientPairingStatus { try await session.status() }
    func mayDiscardReference(_ reference: PairedHostReference) throws -> Bool { false }
}
public struct FileClientClaimJournal: PairedClientClaimJournal {
    private let directory: URL
    private static let maximumBytes = 524_288
    public init(directory: URL) { self.directory = directory.standardizedFileURL }
    public static func applicationArchive() -> FileClientClaimJournal {
        let base = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0]
        return .init(directory:base.appendingPathComponent("Dexter/ClaimJournal",isDirectory:true))
    }
    public func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? {
        try locked(create:false) { entries in try entries.first(where: { try $0.entry().reservation.scope == scope })?.entry() }
    }
    public func assertNoUnknownClaim(installationID: String, role: ClientRole) throws {
        try locked(create:false) { entries in
            guard !entries.contains(where: { $0.installationID == installationID && $0.role == role.rawValue && $0.claimID == nil }) else { throw ClientIdentityFailure.outcomeUnknown }
        }
    }
    public func reserve(_ reservation: ClientClaimReservation) async throws {
        try locked(create:true) { entries in
            guard !entries.contains(where: { $0.installationID == reservation.scope.installationID && $0.role == reservation.scope.role.rawValue && $0.claimID == nil }),
                  !entries.contains(where: { (try? $0.entry().reservation.scope) == reservation.scope }) else { throw ClientIdentityFailure.outcomeUnknown }
            var updated = entries
            if updated.count >= 20 { updated.removeAll { $0.resolved == true && $0.claimID != nil } }
            guard updated.count < 20 else { throw ClaimJournalAdmissionError.capacity }
            updated.append(Record(reservation:reservation,claimID:nil)); try persist(updated)
        }
    }
    public func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws {
        _ = try ClientClaimJournalEntry(reservation:reservation,claimID:claimID)
        try locked(create:true) { entries in
            guard let index = entries.firstIndex(where: { (try? $0.entry().reservation.scope) == reservation.scope }),
                  try entries[index].entry().reservation.matches(reservation),
                  entries[index].claimID == nil || entries[index].claimID == claimID else { throw ClientIdentityFailure.conflict }
            var updated = entries; updated[index] = Record(reservation:reservation,claimID:claimID); try persist(updated)
        }
    }
    /// The status is obtained here from the pinned authenticated session, never from preferences.
    /// Keep the ACK for same-binding restart; reclaim only on a subsequent capacity admission.
    public func statusAndResolve(_ session: ClientPairingSession) async throws -> ClientPairingStatus {
        let pending = try await session.pendingReference()
        let original = try await loadOnly(scope:pending.scope)
        guard let entry = original, entry.claimID == pending.claimID else { throw ClientIdentityFailure.conflict }
        let status = try await session.status()
        let terminal: Bool
        switch status { case .pending: terminal = false; case .approved, .rejected, .expired, .failed: terminal = true }
        if terminal {
            try locked(create:true) { records in
                guard let index = records.firstIndex(where: { (try? $0.entry().reservation.scope) == pending.scope }),
                      try records[index].entry().reservation.matches(entry.reservation), records[index].claimID == entry.claimID else { throw ClientIdentityFailure.conflict }
                var updated = records; updated[index].resolved = true; try persist(updated)
            }
        }
        return status
    }
    public func mayDiscardReference(_ reference: PairedHostReference) throws -> Bool {
        guard !reference.claimOutcomeUnknown else { return false }
        let scope = try reference.scope()
        return try locked(create:false) { records in
            guard let record = records.first(where: { (try? $0.entry().reservation.scope) == scope }) else { return reference.claimID == nil }
            let entry = try record.entry(), host = try reference.host()
            return record.resolved == true && entry.claimID != nil && entry.claimID == reference.claimID &&
                entry.reservation.clientFingerprint == reference.clientFingerprint && entry.reservation.host.url == host.url && entry.reservation.host.certificateDER == host.certificateDER
        }
    }
    private struct Archive: Codable { let version: Int; let records: [Record] }
    private struct Record: Codable {
        let installationID: String, localBindingID: String, role: String, hostURL: String, hostDER: Data, hostFingerprint: String, offerID: String, clientFingerprint: String
        let claimID: String?
        var resolved: Bool?
        init(reservation: ClientClaimReservation, claimID: String?) {
            installationID = reservation.scope.installationID; localBindingID = reservation.scope.localBindingID; role = reservation.scope.role.rawValue
            hostURL = reservation.host.url.absoluteString; hostDER = reservation.host.certificateDER; hostFingerprint = reservation.host.fingerprint
            offerID = reservation.offerID; clientFingerprint = reservation.clientFingerprint; self.claimID = claimID
        }
        func entry() throws -> ClientClaimJournalEntry {
            guard hostURL.utf8.count <= 1024, hostDER.count <= 16_384, let url = URL(string:hostURL), let role = ClientRole(rawValue:role) else { throw ClientIdentityFailure.conflict }
            let scope = try ClientIdentityScope(installationID:installationID,localBindingID:localBindingID,role:role,hostFingerprint:hostFingerprint)
            let host = try PinnedClientHost(url:url,certificateDER:hostDER,fingerprint:hostFingerprint)
            return try .init(reservation:.init(scope:scope,host:host,offerID:offerID,clientFingerprint:clientFingerprint),claimID:claimID)
        }
    }
    private func locked<T>(create: Bool, _ operation: ([Record]) throws -> T) throws -> T {
        if !FileManager.default.fileExists(atPath:directory.path) {
            if !create { return try operation([]) }
            // Sync each newly-created directory in its parent before publishing a reservation.
            var missing: [URL] = []; var cursor = directory
            while !FileManager.default.fileExists(atPath:cursor.path) { missing.append(cursor); cursor.deleteLastPathComponent() }
            for created in missing.reversed() {
                try FileManager.default.createDirectory(at:created,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
                let parent = open(created.deletingLastPathComponent().path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                guard parent >= 0 else { throw ClaimJournalAdmissionError.durability }
                let synced = fsync(parent); Darwin.close(parent)
                guard synced == 0 else { throw ClaimJournalAdmissionError.durability }
            }
        }
        let dir = open(directory.path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard dir >= 0 else { throw ClientIdentityFailure.unavailable }; defer { Darwin.close(dir) }
        var info = stat(); guard fstat(dir,&info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw ClientIdentityFailure.conflict }
        // loadOnly requires an existing lock; archive creation creates it before any metadata.
        let lock = openat(dir,"journal.lock",O_RDWR | O_NOFOLLOW | (create ? O_CREAT : 0),0o600)
        if lock < 0, !create, errno == ENOENT {
            guard faccessat(dir,"claims.json",F_OK,AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw ClientIdentityFailure.conflict }
            return try operation([])
        }
        guard lock >= 0 else { throw ClientIdentityFailure.unavailable }; defer { Darwin.close(lock) }
        guard fstat(lock,&info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_mode & S_IFMT == S_IFREG else { throw ClientIdentityFailure.conflict }
        // Immediate bounded admission: never wait synchronously on MainActor for another process.
        guard flock(lock,LOCK_EX | LOCK_NB) == 0 else { throw ClaimJournalAdmissionError.busy }; defer { flock(lock,LOCK_UN) }
        let records: [Record]
        do { records = try read(dir:dir) }
        catch {
            if create { quarantine(dir:dir) }
            throw ClientIdentityFailure.conflict
        }
        return try operation(records)
    }
    private func read(dir: Int32) throws -> [Record] {
        let fd = openat(dir,"claims.json",O_RDONLY | O_NOFOLLOW)
        if fd < 0, errno == ENOENT { return [] }
        guard fd >= 0 else { throw ClientIdentityFailure.conflict }; defer { Darwin.close(fd) }
        var info = stat(); guard fstat(fd,&info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= Self.maximumBytes else { throw ClientIdentityFailure.conflict }
        var bytes = Data(count:Int(info.st_size)); let count = bytes.withUnsafeMutableBytes { Darwin.read(fd,$0.baseAddress, $0.count) }
        guard count == bytes.count, let object = try JSONSerialization.jsonObject(with:bytes) as? [String:Any], Set(object.keys) == ["version","records"], let rows = object["records"] as? [[String:Any]], rows.count <= 20 else { throw ClientIdentityFailure.conflict }
        let required: Set<String> = ["installationID","localBindingID","role","hostURL","hostDER","hostFingerprint","offerID","clientFingerprint"]
        guard rows.allSatisfy({ Set($0.keys).isSubset(of:required.union(["claimID","resolved"])) && required.isSubset(of:Set($0.keys)) }) else { throw ClientIdentityFailure.conflict }
        let archive = try JSONDecoder().decode(Archive.self,from:bytes); guard archive.version == 1 else { throw ClientIdentityFailure.conflict }
        var scopes: Set<Data> = []
        for record in archive.records { let entry = try record.entry(); guard record.resolved != true || entry.claimID != nil else { throw ClientIdentityFailure.conflict }; guard scopes.insert(entry.reservation.scope.tag).inserted else { throw ClientIdentityFailure.conflict } }
        return archive.records
    }
    private func persist(_ records: [Record]) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; let bytes = try encoder.encode(Archive(version:1,records:records))
        guard bytes.count <= Self.maximumBytes else { throw ClientIdentityFailure.conflict }
        let dir = open(directory.path,O_RDONLY | O_DIRECTORY | O_NOFOLLOW); guard dir >= 0 else { throw ClientIdentityFailure.unavailable }; defer { Darwin.close(dir) }
        let temporary = "claims.pending"
        // The lock permits one bounded staging file, including after process death.
        guard unlinkat(dir,temporary,0) == 0 || errno == ENOENT else { throw ClientIdentityFailure.unavailable }
        let fd = openat(dir,temporary,O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,0o600)
        guard fd >= 0 else { throw ClientIdentityFailure.unavailable }
        defer { Darwin.close(fd); unlinkat(dir,temporary,0) }
        let count = bytes.withUnsafeBytes { Darwin.write(fd,$0.baseAddress,$0.count) }
        guard count == bytes.count, fsync(fd) == 0, renameat(dir,temporary,dir,"claims.json") == 0, fsync(dir) == 0 else { throw ClientIdentityFailure.unavailable }
    }
    private func quarantine(dir: Int32) {
        // Preserve original as permanent barrier. Never rename it away or silently retry empty.
        let source = openat(dir,"claims.json",O_RDONLY | O_NOFOLLOW); guard source >= 0 else { return }; defer { Darwin.close(source) }
        var info = stat(); guard fstat(source,&info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0, info.st_size <= Self.maximumBytes else { return }
        let output = openat(dir,"claims.quarantine",O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,0o600); guard output >= 0 else { return }; defer { Darwin.close(output) }
        var data = Data(count:Int(info.st_size)); let readCount = data.withUnsafeMutableBytes { Darwin.read(source,$0.baseAddress,$0.count) }
        if readCount == data.count { _ = data.withUnsafeBytes { Darwin.write(output,$0.baseAddress,$0.count) }; _ = fsync(output); _ = fsync(dir) }
    }
}

/// Fixture/local-development models cannot accidentally touch production archives.
struct UnavailableClientClaimJournal: PairedClientClaimJournal {
    func assertNoUnknownClaim(installationID: String, role: ClientRole) throws { throw ClientIdentityFailure.unavailable }
    func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? { throw ClientIdentityFailure.unavailable }
    func reserve(_ reservation: ClientClaimReservation) async throws { throw ClientIdentityFailure.unavailable }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws { throw ClientIdentityFailure.unavailable }
}
