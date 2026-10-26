import Testing
@testable import MacCapabilitiesNative

@MainActor private final class SyntheticPermissionRequester: NativePermissionRequesting {
    var state = NativePermissionState(accessibility: false, inputMonitoring: false)
    var accessibilityRequests = 0; var monitoringRequests = 0; var queries = 0
    func current() -> NativePermissionState { queries += 1; return state }
    func requestAccessibility() { accessibilityRequests += 1 }
    func requestInputMonitoring() { monitoringRequests += 1 }
}
@MainActor @Suite struct PermissionPreparationTests {
    @Test func preflightDoesNotPromptAndOpeningARequestDoesNotConfirmGrants() {
        let requester = SyntheticPermissionRequester(), preparation = NativePermissionPreparation(requester: requester)
        #expect(!preparation.current().granted); #expect(requester.accessibilityRequests == 0); #expect(requester.monitoringRequests == 0)
        #expect(!preparation.requestAfterHumanAction().granted)
        #expect(requester.accessibilityRequests == 1); #expect(requester.monitoringRequests == 1); #expect(requester.queries == 3)
        requester.state = .init(accessibility: true, inputMonitoring: true)
        #expect(preparation.requestAfterHumanAction().granted)
        #expect(requester.accessibilityRequests == 1); #expect(requester.monitoringRequests == 1)
    }
    @Test func onlyMissingPermissionIsRequestedAndNoCalibrationOrSurfaceIsGranted() {
        let requester = SyntheticPermissionRequester(); requester.state = .init(accessibility: true, inputMonitoring: false)
        let preparation = NativePermissionPreparation(requester: requester)
        #expect(!preparation.requestAfterHumanAction().granted)
        #expect(requester.accessibilityRequests == 0); #expect(requester.monitoringRequests == 1)
        let backend = NativeBackend(lockSignalsCalibrated: false, access: OneButtonAccess(), permissionRequester: requester)
        #expect(!backend.permissionsGranted); #expect(!backend.indicatorVisible); #expect(backend.selectedPid == nil)
    }
}
