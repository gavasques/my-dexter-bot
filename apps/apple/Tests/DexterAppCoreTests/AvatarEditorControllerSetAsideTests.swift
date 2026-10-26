import CoreGraphics
import DexterHostClient
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import DexterAppCore

/// The image draft an explicit mascot choice sets aside lives in the window's controller, so it survives page switches and
/// comes back with the same bytes; explicit image decisions drop it. Synthetic key and stub transport only.
@MainActor final class AvatarEditorControllerSetAsideTests: XCTestCase {
    private final class MemoryKeyStore: AvatarImageAPIKeyStore {
        var keys: [String: String] = [:]
        func status(hostID: String) -> AvatarImageKeyStatus { keys[hostID] == nil ? .missing : .configured }
        func load(hostID: String) throws -> String { guard let key = keys[hostID] else { throw AvatarImageFailure.keyMissing }; return key }
        func save(_ key: String, hostID: String) throws { keys[hostID] = key }
        func remove(hostID: String) throws { keys[hostID] = nil }
    }

    private struct StubTransport: AvatarImageGenerationTransport {
        let png: Data
        func send(_ request: URLRequest) async throws -> TransportResponse {
            let body = try JSONSerialization.data(withJSONObject: ["data": [["b64_json": png.base64EncodedString()]]])
            return TransportResponse(statusCode: 200, data: body)
        }
    }

    private func png(red: CGFloat) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: red, green: 0.4, blue: 0.8, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        let image = try XCTUnwrap(context.makeImage())
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private func controller(generating png: Data? = nil) -> (AvatarEditorController, MemoryKeyStore) {
        let store = MemoryKeyStore()
        return (AvatarEditorController(keyStore: store, transport: StubTransport(png: png ?? Data())), store)
    }

    func testSetAsideDraftComesBackWithTheSameBytes() throws {
        let (editor, _) = controller()
        try editor.selectImage(try png(red: 0.9))
        let original = try XCTUnwrap(editor.imageDraft)
        editor.setAsideImageDraftForMascot()
        XCTAssertNil(editor.imageDraft)
        XCTAssertEqual(editor.setAsideImageDraft, original)
        // A page switch only drops the editor view; the controller (the window's) keeps the draft.
        XCTAssertTrue(editor.restoreSetAsideImageDraft())
        XCTAssertEqual(editor.imageDraft, original, "same draft ID, bytes and hash: no re-encoding, upload or paid request")
        XCTAssertNil(editor.setAsideImageDraft)
        XCTAssertFalse(editor.restoreSetAsideImageDraft(), "nothing is given back twice")
        // No draft: setting aside is a no-op and leaves nothing to restore.
        editor.removeImage()
        editor.setAsideImageDraftForMascot()
        XCTAssertNil(editor.setAsideImageDraft)
        XCTAssertFalse(editor.restoreSetAsideImageDraft())
    }

    func testExplicitImageDecisionsDropTheSetAsideDraft() async throws {
        let generated = try png(red: 0.1)
        let (editor, store) = controller(generating: generated)
        try editor.selectImage(try png(red: 0.9))
        editor.setAsideImageDraftForMascot()
        try editor.selectImage(try png(red: 0.5))
        XCTAssertNil(editor.setAsideImageDraft, "a new import is the owner's choice")

        editor.setAsideImageDraftForMascot()
        editor.removeImage()
        XCTAssertNil(editor.setAsideImageDraft, "Remover imagem, and Save/Descartar/Recarregar which call removeImage")

        try editor.selectImage(try png(red: 0.7))
        editor.setAsideImageDraftForMascot()
        try store.save("sk-test-0123456789abcdef", hostID: "host-1")
        let ok = await editor.generate(prompt: "um robô verde", hostID: "host-1")
        XCTAssertTrue(ok)
        XCTAssertNotNil(editor.imageDraft)
        XCTAssertNil(editor.setAsideImageDraft, "a generated image is the owner's choice")

        editor.setAsideImageDraftForMascot()
        editor.forgetSetAsideImageDraft()
        XCTAssertNil(editor.setAsideImageDraft, "host scope retired")
    }

    func testSheetCancelPutsBothDraftsBack() throws {
        let (editor, _) = controller()
        try editor.selectImage(try png(red: 0.3))
        let before = editor.imageDraft
        editor.setAsideImageDraftForMascot()
        let setAside = editor.setAsideImageDraft
        editor.restoreDrafts(imageDraft: before, setAside: nil)
        XCTAssertEqual(editor.imageDraft, before)
        XCTAssertNil(editor.setAsideImageDraft)
        editor.restoreDrafts(imageDraft: nil, setAside: setAside)
        XCTAssertNil(editor.imageDraft)
        XCTAssertEqual(editor.setAsideImageDraft, setAside)
    }
}
