import XCTest
@testable import DexterNativeActions

final class NativeCapabilityCatalogTests: XCTestCase {
    func testCatalogIsFiniteLocallyProvedForegroundOnlyAndExcludesHealth() {
        XCTAssertEqual(Set(IOSNativeCapability.allCases), Set([
            .calendar, .contacts, .location, .files, .photos, .camera, .microphone,
        ]))
        XCTAssertTrue(IOSNativeCapabilityCatalog.all.allSatisfy { descriptor in
            descriptor.lifecycle == .foregroundOnly
                && descriptor.backgroundDelivery == .unavailable
                && descriptor.state == .nativeCompiledFixturesProvedPhysicalPending
        })
        XCTAssertNil(IOSNativeCapability(rawValue: "health"))
        XCTAssertNil(IOSNativeCapability(rawValue: "healthkit"))
        XCTAssertEqual(
            Set(IOSNativePermission.allCases),
            Set([.calendarFullAccess, .locationWhenInUse, .camera, .microphone]),
            "Only operations that use a real app permission API appear in this permission enum"
        )
    }

    func testRealPermissionStatesRemainDistinctAndNonAuthorizing() throws {
        let calendar = try XCTUnwrap(IOSNativeCapabilityCatalog.descriptor(for: .calendar))
        XCTAssertEqual(calendar.accessRequirement, .appPermission(.calendarFullAccess))

        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(calendar, permission: .notDetermined, scene: .foreground),
            .permissionRequired(.calendarFullAccess)
        )
        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(calendar, permission: .denied, scene: .foreground),
            .permissionDenied(.calendarFullAccess),
            "A denied permission needs a settings path, not an automatic re-prompt"
        )
        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(calendar, permission: .notChecked, scene: .foreground),
            .deferred(reason: .permissionStateNotChecked)
        )
        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(calendar, permission: .externallyReportedGranted, scene: .foreground),
            .foregroundConfirmationRequired
        )
    }

    func testPickerOnlyCapabilitiesDoNotInventTCCPermissions() throws {
        for capability: IOSNativeCapability in [.contacts, .files, .photos] {
            let descriptor = try XCTUnwrap(IOSNativeCapabilityCatalog.descriptor(for: capability))
            XCTAssertEqual(descriptor.accessRequirement, .explicitSystemPickerSelection)
            for state: IOSNativePermissionState in [.notChecked, .notDetermined, .denied, .externallyReportedGranted] {
                XCTAssertEqual(
                    IOSNativeAdmissionPlanner.evaluate(descriptor, permission: state, scene: .foreground),
                    .systemPickerSelectionRequired,
                    "\(capability) uses an explicit picker and must not request an app TCC permission"
                )
            }
        }
    }

    func testCancellationPrecedesBackgroundLifecycleAndPermissions() throws {
        let camera = try XCTUnwrap(IOSNativeCapabilityCatalog.descriptor(for: .camera))
        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(camera, permission: .externallyReportedGranted, scene: .background),
            .unavailable(reason: .unsupportedBackgroundExecution)
        )
        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(camera, permission: .denied, scene: .background, cancelled: true),
            .unavailable(reason: .cancelled),
            "Cancellation wins even when the scene is already in the background"
        )
        XCTAssertEqual(
            IOSNativeAdmissionPlanner.evaluate(camera, permission: .externallyReportedGranted, scene: .foreground, cancelled: true),
            .unavailable(reason: .cancelled)
        )
    }
}
