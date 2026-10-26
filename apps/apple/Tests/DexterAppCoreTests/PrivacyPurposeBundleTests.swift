import Foundation
import XCTest

/// Validates the strings the system permission prompt can actually load, independently for each target/language.
/// Requires fresh unsigned build bundles; never requests a capability or invokes a provider.
final class PrivacyPurposeBundleTests: XCTestCase {
    private static let appleRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    private static let macMicrophonePT = "O Dexter usa o microfone quando você inicia uma conversa por voz ao vivo e envia o áudio à OpenAI durante a sessão. Você pode silenciar ou parar a sessão a qualquer momento."
    private static let macMicrophoneEN = "Dexter uses the microphone when you start a live voice conversation and sends the audio to OpenAI during the session. You can mute or stop the session at any time."
    private static let networkPT = "O Dexter conecta este app à base do seu Mac e aos aparelhos pareados, quando você solicitar."
    private static let networkEN = "Dexter connects this app to your Mac’s host and paired devices when you request it."
    private static let iosPT = [
        "NSLocalNetworkUsageDescription": networkPT,
        "NSCalendarsFullAccessUsageDescription": "Para permitir que você solicite explicitamente até dez títulos e horários de início de eventos nos próximos 30 dias na tela local de capacidades do Dexter.",
        "NSLocationWhenInUseUsageDescription": "Para permitir que você solicite explicitamente uma coordenada arredondada a 0,01° enquanto usa o Dexter; o iOS e seus ajustes determinam a precisão coletada.",
        "NSCameraUsageDescription": "Para escanear o QR privado de pareamento do seu Mac quando você tocar em Escanear, ou capturar uma imagem quando solicitar nas capacidades do dispositivo.",
        "NSMicrophoneUsageDescription": "Para permitir que você inicie explicitamente até dez segundos de áudio pelo microfone, somente em memória, na tela local de capacidades do Dexter."
    ]
    private static let iosEN = [
        "NSLocalNetworkUsageDescription": networkEN,
        "NSCalendarsFullAccessUsageDescription": "To let you explicitly request up to ten event titles and start times in the next 30 days from Dexter's local capability screen.",
        "NSLocationWhenInUseUsageDescription": "To let you explicitly request one coordinate rounded to 0.01 degrees while using Dexter; iOS and your settings determine acquisition precision.",
        "NSCameraUsageDescription": "To scan your Mac’s private Dexter pairing QR code when you tap Scan, or capture one image when you request it in device capabilities.",
        "NSMicrophoneUsageDescription": "To let you explicitly start up to ten seconds of microphone input, kept in memory only, from Dexter's local capability screen."
    ]
    private static var macPT: [String: String] {
        ["NSLocalNetworkUsageDescription": networkPT, "NSMicrophoneUsageDescription": macMicrophonePT]
    }
    private static var macEN: [String: String] {
        ["NSLocalNetworkUsageDescription": networkEN, "NSMicrophoneUsageDescription": macMicrophoneEN]
    }
    // The existing iOS base has four English capability purposes and the Portuguese network purpose.
    // Preserve that base byte-for-byte; the two localized tables supply the selected language.
    private static var iosBase: [String: String] {
        var result = iosEN
        result["NSLocalNetworkUsageDescription"] = networkPT
        return result
    }

    private func purposes(in dictionary: [String: Any]) -> [String: String] {
        dictionary.reduce(into: [:]) { result, entry in
            if entry.key.hasSuffix("UsageDescription"), let value = entry.value as? String { result[entry.key] = value }
        }
    }

    private func assertBundle(variable: String, language: String, localized expected: [String: String], base: [String: String],
                              file: StaticString = #filePath, line: UInt = #line) throws {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment[variable], "fresh unsigned bundle is required", file: file, line: line)
        let bundle = try XCTUnwrap(Bundle(path: path), file: file, line: line)
        XCTAssertEqual(purposes(in: try XCTUnwrap(bundle.infoDictionary)), base, "base purposes: \(variable)", file: file, line: line)
        let resources = try XCTUnwrap(bundle.resourceURL, file: file, line: line)
        let tableURL = resources.appendingPathComponent(language + ".lproj/InfoPlist.strings")
        let table = try XCTUnwrap(try PropertyListSerialization.propertyList(from: Data(contentsOf: tableURL), format: nil) as? [String: Any], file: file, line: line)
        // The complete table is closed: Mac must not inherit the iPhone's camera/calendar/location/memory-only promises.
        XCTAssertEqual(Set(table.keys), Set(expected.keys), "localized purpose keys: \(variable)/\(language)", file: file, line: line)
        XCTAssertEqual(purposes(in: table), expected, "localized purposes: \(variable)/\(language)", file: file, line: line)
        let localizedBundle = try XCTUnwrap(Bundle(path: tableURL.deletingLastPathComponent().path), file: file, line: line)
        for (key, value) in expected {
            XCTAssertEqual(localizedBundle.localizedString(forKey: key, value: nil, table: "InfoPlist"), value,
                           "system table lookup: \(variable)/\(language)/\(key)", file: file, line: line)
        }
    }

    func testMacEnglishPermissionPurposesDiscloseLiveProviderTransmission() throws {
        try assertBundle(variable: "DEXTER_LOCALIZATION_MAC_BUNDLE", language: "en", localized: Self.macEN, base: Self.macPT)
    }
    func testMacPortuguesePermissionPurposesDiscloseLiveProviderTransmission() throws {
        try assertBundle(variable: "DEXTER_LOCALIZATION_MAC_BUNDLE", language: "pt-BR", localized: Self.macPT, base: Self.macPT)
    }
    func testIOSEnglishPermissionPurposesKeepBoundedCapabilitiesAndPrivateQR() throws {
        try assertBundle(variable: "DEXTER_LOCALIZATION_IOS_BUNDLE", language: "en", localized: Self.iosEN, base: Self.iosBase)
    }
    func testIOSPortuguesePermissionPurposesKeepBoundedCapabilitiesAndPrivateQR() throws {
        try assertBundle(variable: "DEXTER_LOCALIZATION_IOS_BUNDLE", language: "pt-BR", localized: Self.iosPT, base: Self.iosBase)
    }
    func testXcodeGenKeepsPlatformSpecificTablesAndBasePurposes() throws {
        let yaml = try String(contentsOf: Self.appleRoot.appendingPathComponent("Project.yml"), encoding: .utf8)
        let mac = try XCTUnwrap(yaml.components(separatedBy: "  DexterMac:\n").last?.components(separatedBy: "  DexterIOS:\n").first)
        let ios = try XCTUnwrap(yaml.components(separatedBy: "  DexterIOS:\n").last)
        for language in ["en", "pt-BR"] {
            XCTAssertTrue(mac.contains("path: SharedApp/Resources/Mac/\(language).lproj/InfoPlist.strings"))
            XCTAssertFalse(mac.contains("path: SharedApp/Resources/\(language).lproj/InfoPlist.strings"))
            XCTAssertTrue(ios.contains("path: SharedApp/Resources/\(language).lproj/InfoPlist.strings"))
            XCTAssertFalse(ios.contains("path: SharedApp/Resources/Mac/\(language).lproj/InfoPlist.strings"))
        }
        for (section, base) in [(mac, Self.macPT), (ios, Self.iosPT)] {
            for (key, value) in base { XCTAssertTrue(section.contains("        \(key): \(value)"), "XcodeGen must preserve \(key)") }
        }
    }
}
