#if os(macOS)
import Foundation
import XCTest
import DexterKeychainRuntime
@testable import DexterAppCore

@MainActor final class NativeHelperApplicationTests:XCTestCase {
    private func directory()throws->URL {
        let source=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let root=source.deletingLastPathComponent().appendingPathComponent("qa/helper-app-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]);return root
    }
    private func app(_ root:URL,_ kind:NativeHelperApplication.Kind)throws->NativeHelperApplication {
        let bundle=root.appendingPathComponent(kind.applicationName),contents=bundle.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at:contents.appendingPathComponent("MacOS"),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try FileManager.default.createDirectory(at:contents.appendingPathComponent("_CodeSignature"),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let executable=contents.appendingPathComponent("MacOS/"+kind.executableName)
        try Data("synthetic helper never executed".utf8).write(to:executable);try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:executable.path)
        let info:[String:Any]=["CFBundleIdentifier":kind.bundleIdentifier,"CFBundleExecutable":kind.executableName,"CFBundlePackageType":"APPL"]
        try PropertyListSerialization.data(fromPropertyList:info,format:.xml,options:0).write(to:contents.appendingPathComponent("Info.plist"))
        try Data("synthetic signature resource; not a real signature".utf8).write(to:contents.appendingPathComponent("_CodeSignature/CodeResources"))
        return try NativeHelperApplication(bundle:bundle,kind:kind)
    }
    func testWholeBundleStagingPreservesInfoExecutableSignatureAndRefusesOverwrite()throws {
        let root=try directory();defer{try? FileManager.default.removeItem(at:root)}
        let source=try app(root,.identity),dst=root.appendingPathComponent("destination")
        try FileManager.default.createDirectory(at:dst,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let original=try source.snapshot(),staged=try source.stage(to:dst.appendingPathComponent(source.kind.applicationName))
        XCTAssertEqual(try staged.snapshot(),original);XCTAssertEqual(staged.executable.lastPathComponent,"dexter-device-identity")
        XCTAssertThrowsError(try source.stage(to:staged.bundle))
        let signature=staged.bundle.appendingPathComponent("Contents/_CodeSignature/CodeResources")
        try Data("changed public resource".utf8).write(to:signature)
        XCTAssertNotEqual(try staged.snapshot().digest,original.digest,"policy pins must cover bound resources, not just executable bytes")
    }
    func testSymlinkInsideBundleAndWrongBoundIdentityRefuse()throws {
        let root=try directory();defer{try? FileManager.default.removeItem(at:root)}
        let source=try app(root,.cua),link=source.bundle.appendingPathComponent("Contents/external")
        try FileManager.default.createSymbolicLink(at:link,withDestinationURL:URL(fileURLWithPath:"/usr/bin/true"))
        XCTAssertThrowsError(try source.snapshot())
        XCTAssertThrowsError(try NativeHelperApplication(bundle:source.bundle,kind:.identity))
    }
    func testUnsignedWrappingStatusIsExplicitAndCannotCreateOrLoadValue()throws {
        let bad=RuntimeSigningIdentity(validityStatus:0,bundleIdentifier:"com.dexter.qa",codeIdentifier:"com.dexter.qa",teamIdentifier:nil,applicationIdentifier:"com.dexter.qa",accessGroups:[])
        let store=NativeScopedWrappingKeychain(runtimeIdentity:{bad}),scope=try MemoryBackendWrappingScope(hostID:"host_signing_fixture",ownerID:"owner_signing_fixture",origin:"https://uncontacted-memory.invalid")
        XCTAssertEqual(store.status(scope:scope),.signingIdentityUnavailable)
        XCTAssertThrowsError(try store.create(scope:scope)){XCTAssertEqual($0 as? MemoryBackendPrivateFailure,.signingIdentityUnavailable)}
        XCTAssertThrowsError(try store.load(scope:scope)){XCTAssertEqual($0 as? MemoryBackendPrivateFailure,.signingIdentityUnavailable)}
    }
    func testActualSignedCuaBundleStagedWholeKeepsStaticSignatureAndBoundMetadata()throws {
        guard let path=ProcessInfo.processInfo.environment["DEXTER_QA_HELPER_APP"] else { throw XCTSkip("Explicit own helper QA bundle required; never discovers other apps.") }
        let root=try directory();defer{try? FileManager.default.removeItem(at:root)}
        let source=try NativeHelperApplication(bundle:URL(fileURLWithPath:path),kind:.cua),staged=try source.stage(to:root.appendingPathComponent("DexterControl.app"))
        let verify=Process();verify.executableURL=URL(fileURLWithPath:"/usr/bin/codesign");verify.arguments=["--verify","--strict",staged.bundle.path];verify.environment=["PATH":"/usr/bin:/bin"]
        verify.standardOutput=FileHandle.nullDevice;verify.standardError=FileHandle.nullDevice;try verify.run();verify.waitUntilExit();XCTAssertEqual(verify.terminationStatus,0)
        let parent=root.appendingPathComponent("Parent.app/Contents"),meta=parent.appendingPathComponent("Resources/DexterLocalHost")
        try FileManager.default.createDirectory(at:meta,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try FileManager.default.createDirectory(at:parent.appendingPathComponent("Helpers"),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        try FileManager.default.copyItem(at:staged.bundle,to:parent.appendingPathComponent("Helpers/DexterControl.app"))
        let metadata:[String:Any]=["schema":"dexter.mac-cua-helper/2","helper":"Helpers/DexterControl.app","executable":"Contents/MacOS/dexter-cua-helper","automaticStart":false]
        try JSONSerialization.data(withJSONObject:metadata).write(to:meta.appendingPathComponent("mac-cua-helper.json"))
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:meta.appendingPathComponent("mac-cua-helper.json").path)
        let info:[String:Any]=["CFBundleIdentifier":"com.dexter.qa.parent","CFBundlePackageType":"APPL","CFBundleExecutable":"not-launched"]
        try PropertyListSerialization.data(fromPropertyList:info,format:.xml,options:0).write(to:parent.appendingPathComponent("Info.plist"))
        let bundle=try XCTUnwrap(Bundle(url:parent.deletingLastPathComponent()))
        let package=try LocalMacAgentCuaPackage.packaged(in:bundle);XCTAssertNotNil(package.application);XCTAssertEqual(package.application?.kind,.cua)
        XCTAssertTrue(package.executable.path.contains("DexterControl.app/Contents/MacOS"))
    }
}
#endif
