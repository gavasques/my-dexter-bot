import Foundation
import XCTest
@testable import DexterAppCore
#if os(macOS)
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
import Darwin
#endif

final class ChatAppearancePreferencesTests: XCTestCase {
    func testExistingV1KeepsCustomColorsAndDirectionWithoutNewKeys() throws {
        let data = Data(#"{"preset":"custom","top":{"r":0.1,"g":0.2,"b":0.3},"bottom":{"r":0.7,"g":0.8,"b":0.9},"direction":"diagonal"}"#.utf8)
        let settings = try JSONDecoder().decode(ChatAppearanceSettings.self, from: data)
        XCTAssertEqual(settings.preset, .custom); XCTAssertEqual(settings.direction, .diagonal)
        XCTAssertEqual(settings.top, .init(r: 0.1, g: 0.2, b: 0.3))
        XCTAssertEqual(settings.bottom, .init(r: 0.7, g: 0.8, b: 0.9))
        XCTAssertEqual(settings.backgroundOpacity, 1); XCTAssertEqual(settings.panelOpacity, 0.30)
        XCTAssertNil(settings.wallpaper)
    }

    func testInvalidStoredRangesAndPhotoIdentifiersAreRefused() throws {
        let baseline = try JSONEncoder().encode(ChatAppearanceSettings())
        for (key, value) in [("backgroundOpacity", -0.1), ("backgroundOpacity", 1.1), ("panelOpacity", 0.1), ("imageBlur", 25)] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: baseline) as? [String: Any])
            object[key] = value
            XCTAssertThrowsError(try JSONDecoder().decode(ChatAppearanceSettings.self, from: JSONSerialization.data(withJSONObject: object)))
        }
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: baseline) as? [String: Any])
        object["preset"] = "image"
        XCTAssertThrowsError(try JSONDecoder().decode(ChatAppearanceSettings.self, from: JSONSerialization.data(withJSONObject: object)))
        object["wallpaper"] = ["id": "../outside", "sha256": String(repeating: "a", count: 64), "width": 20, "height": 20, "byteCount": 10]
        XCTAssertThrowsError(try JSONDecoder().decode(ChatAppearanceSettings.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    func testRoundTripContainsMetadataOnlyAndZeroOpacityKeepsTheWindowTheme() throws {
        var settings = ChatAppearanceSettings(); settings.preset = .image
        settings.wallpaper = .init(id: UUID(), sha256: String(repeating: "a", count: 64), width: 512, height: 256, byteCount: 1_024)
        settings.backgroundOpacity = 0; settings.panelOpacity = 0.75; settings.imageBlur = 8
        let data = try JSONEncoder().encode(settings)
        XCTAssertEqual(try JSONDecoder().decode(ChatAppearanceSettings.self, from: data), settings)
        XCTAssertTrue(settings.hasBackground); XCTAssertFalse(settings.usesLightAppearance)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let photo = try XCTUnwrap(object["wallpaper"] as? [String: Any])
        XCTAssertEqual(Set(photo.keys), ["id", "sha256", "width", "height", "byteCount"])
        XCTAssertLessThan(data.count, 1_024)
    }

    func testProtectiveLayerKeepsPrimaryTextReadableAtBothCustomGradientEnds() {
        let pairs: [(ChatBackdropRGB, ChatBackdropRGB)] = [(.init(r: 0, g: 0, b: 0), .init(r: 1, g: 1, b: 1)),
            (.init(r: 1, g: 0, b: 0), .init(r: 0, g: 1, b: 0)), (.init(r: 0.92, g: 0.95, b: 1), .init(r: 0.8, g: 0.7, b: 0.6))]
        for (a, b) in pairs {
            for opacity in [0.1, 0.5, 1.0] {
                var s = ChatAppearanceSettings(); s.preset = .custom; s.top = a; s.bottom = b; s.backgroundOpacity = opacity
                let alpha = s.readabilityScrim, light = s.usesLightAppearance, base = light ? 0.95 : 0.09
                func channel(_ c: Double) -> Double { (c * opacity + base * (1 - opacity)) * (1 - alpha) + (light ? alpha : 0) }
                for stop in [a, b] {
                    let luma = ChatBackdropRGB(r: channel(stop.r), g: channel(stop.g), b: channel(stop.b)).luminance
                    let contrast = light ? (luma + 0.05) / 0.05 : 1.05 / (luma + 0.05)
                    XCTAssertGreaterThanOrEqual(contrast, 4.5)
                }
            }
        }
    }

    #if os(macOS)
    private func withPrivateFolder(_ body: (URL) throws -> Void) throws {
        let parent = ProcessInfo.processInfo.environment["DEXTER_APPEARANCE_TEST_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let folder = parent.appendingPathComponent("wallpaper-qa-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        try body(folder)
    }
    private func png(width: Int = 64, height: Int = 48, metadata: Bool = false) throws -> Data {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.6, alpha: 1)); context.fill(.init(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage()), data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = metadata ? [kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "synthetic-private-comment"],
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 10.0, kCGImagePropertyGPSLatitudeRef: "N"]] : [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination)); return data as Data
    }

    func testImportReencodesPixelsWithoutGPSOrEXIFAndBoundsDimensions() throws {
        let input = try png(width: 4_200, height: 20, metadata: true)
        let originalSource = try XCTUnwrap(CGImageSourceCreateWithData(input as CFData, nil))
        let originalProperties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(originalSource, 0, nil) as? [CFString: Any])
        let originalExif = try XCTUnwrap(originalProperties[kCGImagePropertyExifDictionary] as? [CFString: Any])
        XCTAssertEqual(originalExif[kCGImagePropertyExifUserComment] as? String, "synthetic-private-comment")
        XCTAssertNotNil(originalProperties[kCGImagePropertyGPSDictionary])
        let prepared = try ChatWallpaperRepository.prepare(data: input)
        XCTAssertLessThanOrEqual(prepared.width, 4_096); XCTAssertGreaterThan(prepared.height, 0)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(prepared.jpeg as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.jpeg.identifier)
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        // ImageIO can emit its own dimensions/color-space EXIF for the new JPEG, never the original personal tags.
        let generatedExif = properties[kCGImagePropertyExifDictionary] as? [String: Any] ?? [:]
        XCTAssertTrue(Set(generatedExif.keys).isSubset(of: ["ColorSpace", "PixelXDimension", "PixelYDimension"]))
        XCTAssertFalse(String(decoding: prepared.jpeg, as: UTF8.self).contains("synthetic-private-comment"))
    }

    func testOversizedAndNonImageInputsAreRefusedBeforeCustody() {
        XCTAssertThrowsError(try ChatWallpaperRepository.prepare(data: Data(count: ChatWallpaperRepository.inputLimit + 1))) {
            XCTAssertEqual($0 as? ChatWallpaperError, .imageTooLarge)
        }
        XCTAssertThrowsError(try ChatWallpaperRepository.prepare(data: Data("not an image".utf8))) {
            XCTAssertEqual($0 as? ChatWallpaperError, .invalidImage)
        }
    }

    func testNonRegularAndLinkedSourcesRefuseWithoutWaitingForBytes() throws {
        try withPrivateFolder { folder in
            let pipe = folder.appendingPathComponent("synthetic-input.png")
            XCTAssertEqual(mkfifo(pipe.path, 0o600), 0)
            XCTAssertThrowsError(try ChatWallpaperRepository.prepare(file: pipe))
            let original = folder.appendingPathComponent("synthetic.png"); try png().write(to: original)
            let linked = folder.appendingPathComponent("link.png")
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: original)
            XCTAssertThrowsError(try ChatWallpaperRepository.prepare(file: linked))
        }
    }

    func testCopiedPhotoSurvivesReopenAndRemovalNeverTouchesOriginal() throws {
        try withPrivateFolder { folder in
            let original = folder.appendingPathComponent("synthetic-original.png"), input = try png()
            try input.write(to: original)
            let root = folder.appendingPathComponent("private-copy", isDirectory: true)
            let repository = ChatWallpaperRepository(root: root)
            let prepared = try ChatWallpaperRepository.prepare(file: original), reference = try repository.store(prepared)
            XCTAssertEqual(try ChatWallpaperRepository(root: root).load(reference), prepared.jpeg)
            let file = root.appendingPathComponent(reference.filename)
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
            try repository.remove(reference)
            XCTAssertEqual(try Data(contentsOf: original), input); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        }
    }

    func testTamperedCopyAndLinkedFileCannotBeReadOrRemovedAsWallpaper() throws {
        try withPrivateFolder { folder in
            let repository = ChatWallpaperRepository(root: folder.appendingPathComponent("copy", isDirectory: true))
            let prepared = try ChatWallpaperRepository.prepare(data: png()), reference = try repository.store(prepared)
            let file = repository.root.appendingPathComponent(reference.filename)
            var modified = prepared.jpeg; modified[0] ^= 1
            let fd = open(file.path, O_WRONLY | O_NOFOLLOW); XCTAssertGreaterThanOrEqual(fd, 0)
            _ = modified.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }; close(fd)
            XCTAssertThrowsError(try repository.load(reference)); XCTAssertThrowsError(try repository.remove(reference))
            try FileManager.default.removeItem(at: file)
            let outside = folder.appendingPathComponent("synthetic-other.jpg"); try prepared.jpeg.write(to: outside)
            try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
            XCTAssertThrowsError(try repository.load(reference)); XCTAssertThrowsError(try repository.remove(reference))
            XCTAssertEqual(try Data(contentsOf: outside), prepared.jpeg)
        }
    }

    func testSymlinkedOrPublicCustodyRootIsRefusedWithoutWritingFiles() throws {
        try withPrivateFolder { folder in
            let other = folder.appendingPathComponent("other", isDirectory: true)
            try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let link = folder.appendingPathComponent("linked", isDirectory: true)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: other)
            let prepared = try ChatWallpaperRepository.prepare(data: png())
            XCTAssertThrowsError(try ChatWallpaperRepository(root: link).store(prepared))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: other.path), [])
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: other.path)
            XCTAssertThrowsError(try ChatWallpaperRepository(root: other).store(prepared))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: other.path), [])
        }
    }
    #endif
}
