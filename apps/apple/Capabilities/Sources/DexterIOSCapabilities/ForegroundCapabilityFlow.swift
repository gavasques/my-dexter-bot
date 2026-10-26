import Foundation
import Observation
import DexterNativeActions

@MainActor
public protocol IOSForegroundPermissionPreparationBackend: Sendable {
    /// This is called only after a visible local tap and performs permission setup only.
    /// It must never read capability data or retain a capability consent.
    func preparePermission(for capability: IOSNativeCapability) async throws
}

public enum IOSForegroundCapabilityScenePhase: Sendable, Equatable {
    case active
    case inactive
    case background
}

public enum IOSForegroundCapabilityFlowStatus: Sendable, Equatable {
    case ready
    case needsPermissionPreparation
    case preparingPermission
    case permissionPrepared
    case permissionPreparedAwaitingActive
    case permissionSetupDraining
    case running
    case operationDraining
    case completed
    case inactive
    case background
    case cancelled
    case changed
    case consentExpired
    case alreadyUsed
    case busy
    case permissionDenied
    case empty
    case offline
    case unsupported
    case pickerCancelled
    case resultRejected
    case failed

    var localizationKey: String {
        switch self {
        case .ready: "capability.ready"
        case .needsPermissionPreparation: "capability.permission-preparation-required"
        case .preparingPermission: "capability.preparing-permission"
        case .permissionPrepared: "capability.permission-setup-ready"
        case .permissionPreparedAwaitingActive: "capability.permission-setup-return"
        case .permissionSetupDraining: "capability.permission-setup-draining"
        case .running: "capability.running"
        case .operationDraining: "capability.operation-draining"
        case .completed: "capability.complete"
        case .inactive: "capability.inactive"
        case .background: "capability.background"
        case .cancelled, .pickerCancelled: "capability.cancelled"
        case .changed: "capability.changed"
        case .consentExpired: "capability.expired"
        case .alreadyUsed: "capability.used"
        case .busy: "capability.busy"
        case .permissionDenied: "capability.permission-denied"
        case .empty: "capability.empty"
        case .offline: "capability.offline"
        case .unsupported: "capability.unsupported"
        case .resultRejected: "capability.result-rejected"
        case .failed: "capability.failed"
        }
    }
}

public enum IOSForegroundCapabilityTapOutcome: Sendable {
    case permissionPrepared
    case result(IOSForegroundCapabilityResult)
}

/// Owns the local two-tap permission-setup/data-operation flow.
/// An OS alert returning never resumes a capability operation automatically.
@MainActor
@Observable
public final class IOSForegroundCapabilityFlowController {
    private struct PermissionAttempt {
        let id: UUID
        let scopeID: UUID
        let capability: IOSNativeCapability
        var validForCurrentSelection: Bool
    }

    public private(set) var selectedCapability: IOSNativeCapability
    public private(set) var status: IOSForegroundCapabilityFlowStatus
    public private(set) var result: IOSForegroundCapabilityResult?

    private let boundary: IOSForegroundCapabilityBoundary
    private let permissionBackend: any IOSForegroundPermissionPreparationBackend
    private var scopeID = UUID()
    private var scenePhase: IOSForegroundCapabilityScenePhase = .active
    private var isVisible = true
    private var preparedCapability: IOSNativeCapability?
    private var preparedScopeID: UUID?
    private var permissionAttempt: PermissionAttempt?
    private var activeEffectID: UUID?
    private var effectInFlight = false
    private var operationWasCancelled = false
    private var explicitCancelRequested = false

    public init(boundary: IOSForegroundCapabilityBoundary,
                permissionBackend: any IOSForegroundPermissionPreparationBackend,
                initialCapability: IOSNativeCapability = .calendar) {
        self.boundary = boundary
        self.permissionBackend = permissionBackend
        selectedCapability = initialCapability
        status = Self.requiresPermissionPreparation(initialCapability) ? .needsPermissionPreparation : .ready
    }

    public static func requiresPermissionPreparation(_ capability: IOSNativeCapability) -> Bool {
        switch capability {
        case .calendar, .location, .camera, .microphone: true
        case .contacts, .files, .photos: false
        }
    }

    public var permissionIsPreparedForSelection: Bool {
        preparedCapability == selectedCapability && preparedScopeID == scopeID
    }

    public var isPreparingPermission: Bool {
        permissionAttempt?.validForCurrentSelection == true
    }

    public var isDrainingPermissionPreparation: Bool {
        permissionAttempt?.validForCurrentSelection == false
    }

    public var isRunning: Bool { effectInFlight }

    public var isBusy: Bool { effectInFlight || permissionAttempt != nil }

    public var needsPermissionPreparation: Bool {
        Self.requiresPermissionPreparation(selectedCapability) && !permissionIsPreparedForSelection
    }

    public func viewAppeared(in phase: IOSForegroundCapabilityScenePhase) async {
        isVisible = true
        scenePhase = phase
        await boundary.setForegroundActive(phase == .active, scopeID: scopeID)
        updateIdleStatus()
    }

    public func select(_ capability: IOSNativeCapability) async {
        guard capability != selectedCapability else { return }
        let previousScope = scopeID
        selectedCapability = capability
        scopeID = UUID()
        preparedCapability = nil
        preparedScopeID = nil
        result = nil
        invalidatePendingPermissionAttempt()
        updateIdleStatus()
        await boundary.revoke(scopeID: previousScope)
        if isVisible && scenePhase == .active {
            await boundary.setForegroundActive(true, scopeID: scopeID)
        }
    }

    public func sceneDidChange(to phase: IOSForegroundCapabilityScenePhase) async {
        scenePhase = phase
        result = nil
        if phase == .background {
            preparedCapability = nil
            preparedScopeID = nil
            invalidatePendingPermissionAttempt()
        }
        await boundary.setForegroundActive(isVisible && phase == .active, scopeID: scopeID)
        if effectInFlight {
            operationWasCancelled = true
            status = .operationDraining
        } else if permissionAttempt != nil {
            status = permissionAttempt?.validForCurrentSelection == true
                ? .preparingPermission : .permissionSetupDraining
        } else if phase == .inactive && permissionIsPreparedForSelection {
            status = .permissionPreparedAwaitingActive
        } else if phase == .active {
            updateIdleStatus()
        } else {
            status = phase == .background ? .background : .inactive
        }
    }

    public func viewDisappeared() async {
        isVisible = false
        let previousScope = scopeID
        scopeID = UUID()
        preparedCapability = nil
        preparedScopeID = nil
        result = nil
        invalidatePendingPermissionAttempt()
        if effectInFlight {
            operationWasCancelled = true
            status = .operationDraining
        } else if permissionAttempt != nil {
            status = .permissionSetupDraining
        } else {
            status = .cancelled
        }
        await boundary.revoke(scopeID: previousScope)
    }

    /// Called only from the local button. A permission-setup tap and a data-operation tap are separate.
    public func humanTapped() async throws -> IOSForegroundCapabilityTapOutcome {
        guard isVisible, scenePhase == .active else { throw IOSForegroundCapabilityError.inactive }
        guard !effectInFlight, permissionAttempt == nil else {
            status = .busy
            throw IOSForegroundCapabilityError.busy
        }
        if needsPermissionPreparation {
            return try await preparePermissionFromHumanTap()
        }
        return .result(try await performFromHumanTap())
    }

    public func cancel() async {
        result = nil
        if var attempt = permissionAttempt {
            attempt.validForCurrentSelection = false
            permissionAttempt = attempt
            status = .permissionSetupDraining
        } else if effectInFlight {
            operationWasCancelled = true
            explicitCancelRequested = true
            status = .operationDraining
        } else {
            status = .cancelled
        }
        await boundary.revoke(scopeID: scopeID)
    }

    private func preparePermissionFromHumanTap() async throws -> IOSForegroundCapabilityTapOutcome {
        let attemptID = UUID()
        let originalScope = scopeID
        let originalCapability = selectedCapability
        permissionAttempt = PermissionAttempt(id: attemptID, scopeID: originalScope,
                                              capability: originalCapability, validForCurrentSelection: true)
        result = nil
        status = .preparingPermission
        do {
            try await permissionBackend.preparePermission(for: originalCapability)
            guard let attempt = permissionAttempt, attempt.id == attemptID else {
                throw IOSForegroundCapabilityError.requestChanged
            }
            permissionAttempt = nil
            guard attempt.validForCurrentSelection, isVisible,
                  selectedCapability == originalCapability, scopeID == originalScope else {
                updateIdleStatus()
                throw IOSForegroundCapabilityError.requestChanged
            }
            try Task.checkCancellation()
            preparedCapability = originalCapability
            preparedScopeID = originalScope
            status = scenePhase == .active ? .permissionPrepared : .permissionPreparedAwaitingActive
            return .permissionPrepared
        } catch {
            if permissionAttempt?.id == attemptID {
                let wasValid = permissionAttempt?.validForCurrentSelection == true
                permissionAttempt = nil
                if wasValid, error is IOSForegroundCapabilityError,
                   (error as? IOSForegroundCapabilityError) == .permissionDenied {
                    preparedCapability = nil
                    preparedScopeID = nil
                    status = .permissionDenied
                } else if wasValid, !Task.isCancelled, isVisible {
                    status = scenePhase == .active ? .failed : .inactive
                } else {
                    updateIdleStatus()
                }
            }
            if Task.isCancelled { throw CancellationError() }
            throw error
        }
    }

    private func performFromHumanTap() async throws -> IOSForegroundCapabilityResult {
        let effectID = UUID()
        let effectScope = scopeID
        let effectCapability = selectedCapability
        activeEffectID = effectID
        effectInFlight = true
        operationWasCancelled = false
        explicitCancelRequested = false
        result = nil
        status = .running
        defer {
            if activeEffectID == effectID {
                activeEffectID = nil
                effectInFlight = false
                if operationWasCancelled || status == .operationDraining {
                    operationWasCancelled = false
                    if explicitCancelRequested && scopeID == effectScope && isVisible && scenePhase == .active {
                        status = .cancelled
                    } else {
                        updateIdleStatus()
                    }
                    explicitCancelRequested = false
                }
            }
        }

        do {
            await boundary.setForegroundActive(true, scopeID: effectScope)
            try validateCurrentEffect(effectID, scopeID: effectScope, capability: effectCapability)
            let requestID = UUID()
            let consent = try await boundary.consentToRequest(scopeID: effectScope,
                                                              requestID: requestID,
                                                              capability: effectCapability)
            try validateCurrentEffect(effectID, scopeID: effectScope, capability: effectCapability)
            let completed = try await boundary.perform(consent: consent, scopeID: effectScope,
                                                       requestID: requestID, capability: effectCapability)
            try validateCurrentEffect(effectID, scopeID: effectScope, capability: effectCapability)
            result = completed
            status = .completed
            return completed
        } catch {
            if activeEffectID == effectID, scopeID == effectScope {
                if let known = error as? IOSForegroundCapabilityError {
                    status = Self.status(for: known)
                    if known == .permissionDenied {
                        preparedCapability = nil
                        preparedScopeID = nil
                    }
                } else if Task.isCancelled {
                    status = .cancelled
                    operationWasCancelled = true
                    explicitCancelRequested = true
                } else {
                    status = .failed
                }
            }
            throw error
        }
    }

    private func validateCurrentEffect(_ id: UUID, scopeID: UUID, capability: IOSNativeCapability) throws {
        try Task.checkCancellation()
        guard isVisible, scenePhase == .active else { throw IOSForegroundCapabilityError.inactive }
        guard activeEffectID == id, self.scopeID == scopeID, selectedCapability == capability else {
            throw IOSForegroundCapabilityError.requestChanged
        }
    }

    private func invalidatePendingPermissionAttempt() {
        guard var attempt = permissionAttempt else { return }
        attempt.validForCurrentSelection = false
        permissionAttempt = attempt
    }

    private func updateIdleStatus() {
        if permissionAttempt != nil {
            status = permissionAttempt?.validForCurrentSelection == true ? .preparingPermission : .permissionSetupDraining
        } else if effectInFlight {
            status = .operationDraining
        } else if !isVisible {
            status = .cancelled
        } else if scenePhase == .background {
            status = .background
        } else if scenePhase == .inactive {
            status = permissionIsPreparedForSelection ? .permissionPreparedAwaitingActive : .inactive
        } else if permissionIsPreparedForSelection {
            status = .permissionPrepared
        } else if Self.requiresPermissionPreparation(selectedCapability) {
            status = .needsPermissionPreparation
        } else {
            status = .ready
        }
    }

    private static func status(for error: IOSForegroundCapabilityError) -> IOSForegroundCapabilityFlowStatus {
        switch error {
        case .inactive: .inactive
        case .invalidRequest, .requestChanged: .changed
        case .consentMissing, .consentExpired: .consentExpired
        case .alreadyUsed: .alreadyUsed
        case .busy: .busy
        case .permissionDenied: .permissionDenied
        case .permissionPreparationRequired: .needsPermissionPreparation
        case .empty: .empty
        case .offline: .offline
        case .unsupported: .unsupported
        case .pickerCancelled: .pickerCancelled
        case .resultRejected: .resultRejected
        case .backendUnavailable: .failed
        }
    }
}
