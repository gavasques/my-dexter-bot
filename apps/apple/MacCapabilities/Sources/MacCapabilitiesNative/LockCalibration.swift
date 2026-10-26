import Foundation

/// Empirical signals only. No key absence or notification alone proves an unlocked screen.
struct LockCalibrationSample: Sendable {
    let uid: UInt32?
    let console: UInt32?
    let onConsole: Bool?
    let loginDone: Bool?
    let lockKey: Bool?
    let displaysAwake: Bool
    let sessionActive: Bool
    let notificationLocked: Bool
    let lockEvents: UInt64

    func coherentUnlocked(uid expectedUID: UInt32, console expectedConsole: UInt32) -> Bool {
        uid == expectedUID && console == expectedConsole && onConsole == true && loginDone == true
            && lockKey == false && displaysAwake && sessionActive && !notificationLocked
    }
}

/// Pure process-local state machine. Native UI supplies observations and a separate operator confirmation.
struct LockCalibrationAttempt: Sendable {
    enum Phase: Equatable, Sendable {
        case idle, waitingForLock, waitingForUnlock, awaitingConfirmation, calibrated
        case refused(Reason)
    }
    enum Reason: Equatable, Sendable { case permissions, incompatible, incoherent, timedOut, cancelled, expired }
    private(set) var phase: Phase = .idle
    private var uid: UInt32 = 0
    private var console: UInt32 = 0
    private var initialLockEvents: UInt64 = 0
    private var deadline: TimeInterval = 0
    private var expiresAt: TimeInterval = 0
    private var coherentUnlockSamples = 0
    static let attemptSeconds: TimeInterval = 180
    static let validitySeconds: TimeInterval = 30 * 60

    mutating func begin(_ sample: LockCalibrationSample, permissions: Bool, expectedUID: UInt32, now: TimeInterval) {
        guard permissions else { phase = .refused(.permissions); return }
        guard let console = sample.console, sample.lockKey != nil else { phase = .refused(.incompatible); return }
        guard sample.coherentUnlocked(uid: expectedUID, console: console) else { phase = .refused(.incoherent); return }
        uid = expectedUID; self.console = console; initialLockEvents = sample.lockEvents
        deadline = now + Self.attemptSeconds; expiresAt = 0; coherentUnlockSamples = 0
        phase = .waitingForLock
    }

    mutating func observe(_ sample: LockCalibrationSample, permissions: Bool, now: TimeInterval) {
        guard phase == .waitingForLock || phase == .waitingForUnlock || phase == .awaitingConfirmation else { return }
        guard permissions else { phase = .refused(.permissions); return }
        guard now < deadline else { phase = .refused(.timedOut); return }
        guard sample.lockKey != nil else { phase = .refused(.incompatible); return }
        guard sample.uid == uid, sample.console == console, sample.onConsole != nil, sample.loginDone == true else {
            phase = .refused(.incoherent); return
        }
        switch phase {
        case .waitingForLock:
            if sample.lockKey == true, sample.lockEvents > initialLockEvents, sample.notificationLocked {
                phase = .waitingForUnlock
            }
        case .waitingForUnlock:
            if sample.coherentUnlocked(uid: uid, console: console) {
                coherentUnlockSamples += 1
                if coherentUnlockSamples >= 3 { phase = .awaitingConfirmation }
            } else { coherentUnlockSamples = 0 }
        case .awaitingConfirmation:
            guard sample.coherentUnlocked(uid: uid, console: console) else { phase = .refused(.incoherent); return }
        default: break
        }
    }

    mutating func confirm(_ sample: LockCalibrationSample, permissions: Bool, now: TimeInterval) -> Bool {
        observe(sample, permissions: permissions, now: now)
        guard phase == .awaitingConfirmation, permissions, sample.coherentUnlocked(uid: uid, console: console) else { return false }
        expiresAt = now + Self.validitySeconds
        phase = .calibrated
        return true
    }

    mutating func permitsUnlocked(_ sample: LockCalibrationSample, permissions: Bool, now: TimeInterval) -> Bool {
        guard phase == .calibrated else { return false }
        guard now < expiresAt else { phase = .refused(.expired); return false }
        guard permissions else { phase = .refused(.permissions); return false }
        guard sample.lockKey != nil, sample.uid == uid, sample.console == console else { phase = .refused(.incoherent); return false }
        return sample.coherentUnlocked(uid: uid, console: console)
    }

    mutating func cancel() { phase = .refused(.cancelled); expiresAt = 0 }
}
