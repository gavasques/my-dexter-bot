import Foundation

public enum IOSNativeCapability: String, CaseIterable, Equatable, Hashable, Sendable {
    case calendar
    case contacts
    case location
    case files
    case photos
    case camera
    case microphone
}

public enum IOSNativeOperation: String, Equatable, Sendable {
    case readUpcomingEventSummaries
    case readSelectedContactName
    case readApproximateCurrentLocation
    case readUserSelectedFile
    case readUserSelectedPhoto
    case captureOnePhotoInMemory
    case captureShortAudioInMemory
}

/// Permissions that map to real system authorization APIs used by the planned operation.
public enum IOSNativePermission: String, CaseIterable, Equatable, Sendable {
    case calendarFullAccess
    case locationWhenInUse
    case camera
    case microphone
}

public enum IOSNativeAccessRequirement: Equatable, Sendable {
    case appPermission(IOSNativePermission)
    case explicitSystemPickerSelection
}

public enum IOSNativeLifecycle: String, Equatable, Sendable {
    case foregroundOnly
}

public enum IOSNativeBackgroundDelivery: String, Equatable, Sendable {
    case unavailable
}

public enum IOSNativeImplementationState: Equatable, Sendable {
    case deferred
    case nativeCompiledFixturesProvedPhysicalPending
    case unavailable
    case permissionRequired
}

public struct IOSNativeCapabilityDescriptor: Equatable, Sendable, Identifiable {
    public let id: IOSNativeCapability
    public let operation: IOSNativeOperation
    public let minimalScope: String
    public let accessRequirement: IOSNativeAccessRequirement
    public let lifecycle: IOSNativeLifecycle
    public let backgroundDelivery: IOSNativeBackgroundDelivery
    public let state: IOSNativeImplementationState

    fileprivate init(
        id: IOSNativeCapability,
        operation: IOSNativeOperation,
        minimalScope: String,
        accessRequirement: IOSNativeAccessRequirement,
        state: IOSNativeImplementationState = .deferred
    ) {
        self.id = id
        self.operation = operation
        self.minimalScope = minimalScope
        self.accessRequirement = accessRequirement
        lifecycle = .foregroundOnly
        backgroundDelivery = .unavailable
        self.state = state
    }
}

/// Metadata and a pure admission planner. Providers and UI are in DexterIOSCapabilities.
/// This catalog never queries permission, opens a picker, prompts, or reads data.
public enum IOSNativeCapabilityCatalog {
    public static let all: [IOSNativeCapabilityDescriptor] = [
        .init(id: .calendar, operation: .readUpcomingEventSummaries,
              minimalScope: "Up to ten upcoming event titles and start times; no notes or attendees.", accessRequirement: .appPermission(.calendarFullAccess), state: .nativeCompiledFixturesProvedPhysicalPending),
        .init(id: .contacts, operation: .readSelectedContactName,
              minimalScope: "One contact selected by the person; name only.", accessRequirement: .explicitSystemPickerSelection, state: .nativeCompiledFixturesProvedPhysicalPending),
        .init(id: .location, operation: .readApproximateCurrentLocation,
              minimalScope: "One approximate location while the app is visibly in use.", accessRequirement: .appPermission(.locationWhenInUse), state: .nativeCompiledFixturesProvedPhysicalPending),
        .init(id: .files, operation: .readUserSelectedFile,
              minimalScope: "One file explicitly selected in the system picker; read-only, plain text only, and at most 1 MiB.", accessRequirement: .explicitSystemPickerSelection, state: .nativeCompiledFixturesProvedPhysicalPending),
        .init(id: .photos, operation: .readUserSelectedPhoto,
              minimalScope: "One photo explicitly selected in the system picker; no library enumeration and at most 10 MiB after downsampling.", accessRequirement: .explicitSystemPickerSelection, state: .nativeCompiledFixturesProvedPhysicalPending),
        .init(id: .camera, operation: .captureOnePhotoInMemory,
              minimalScope: "One person-started still frame held in memory; no automatic Photos save and at most 10 MiB after downsampling.", accessRequirement: .appPermission(.camera), state: .nativeCompiledFixturesProvedPhysicalPending),
        .init(id: .microphone, operation: .captureShortAudioInMemory,
              minimalScope: "One person-started recording up to ten seconds, held in memory only and at most 1,000,000 bytes.", accessRequirement: .appPermission(.microphone), state: .nativeCompiledFixturesProvedPhysicalPending),
    ]

    public static func descriptor(for capability: IOSNativeCapability) -> IOSNativeCapabilityDescriptor? {
        all.first { $0.id == capability }
    }
}

public enum IOSNativePermissionState: Equatable, Sendable {
    /// No TCC query is performed here; this value is supplied only to the pure admission planner.
    case notChecked
    case notDetermined
    case denied
    case externallyReportedGranted
}

public enum IOSNativeSceneState: Equatable, Sendable {
    case foreground
    case background
}

public enum IOSNativeAdmission: Equatable, Sendable {
    case deferred(reason: DeferredReason)
    case foregroundConfirmationRequired
    case systemPickerSelectionRequired
    case permissionRequired(IOSNativePermission)
    case permissionDenied(IOSNativePermission)
    case unavailable(reason: UnavailableReason)

    public enum DeferredReason: Equatable, Sendable {
        case backendNotImplemented
        case systemPickerSelectionRequired
        case permissionStateNotChecked
    }

    public enum UnavailableReason: Equatable, Sendable {
        case cancelled
        case unsupportedBackgroundExecution
    }
}

/// Pure lifecycle/permission planner. Local UI still requires a person's one-time confirmation;
/// this catalog never requests permission, opens a picker, or executes an operation.
public enum IOSNativeAdmissionPlanner {
    public static func evaluate(
        _ capability: IOSNativeCapabilityDescriptor,
        permission: IOSNativePermissionState,
        scene: IOSNativeSceneState,
        cancelled: Bool = false
    ) -> IOSNativeAdmission {
        if cancelled { return .unavailable(reason: .cancelled) }
        guard scene == .foreground else { return .unavailable(reason: .unsupportedBackgroundExecution) }

        switch capability.accessRequirement {
        case .explicitSystemPickerSelection:
            return .systemPickerSelectionRequired
        case .appPermission(let requiredPermission):
            switch permission {
            case .denied:
                return .permissionDenied(requiredPermission)
            case .notDetermined:
                return .permissionRequired(requiredPermission)
            case .notChecked:
                return .deferred(reason: .permissionStateNotChecked)
            case .externallyReportedGranted:
                return .foregroundConfirmationRequired
            }
        }
    }
}
