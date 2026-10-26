import Foundation

/// Display-only lookup. Unknown text is returned verbatim; callers must never pass user content as a key.
/// English is the fallback for unsupported languages. A supplied locale allows deterministic bundle verification.
public enum DexterLocalization {
    public static func text(_ key: String, bundle: Bundle = .main, locale: Locale? = nil) -> String {
        let preferences = locale.map { [$0.identifier] } ?? Locale.preferredLanguages
        let language = Bundle.preferredLocalizations(from: ["en", "pt-BR"], forPreferences: preferences).first ?? "en"
        guard let path = bundle.path(forResource: language, ofType: "lproj"),
              let localizedBundle = Bundle(path: path) else { return key }
        return localizedBundle.localizedString(forKey: key, value: key, table: "Localizable")
    }

    public static func format(_ key: String, _ argument: String, bundle: Bundle = .main, locale: Locale? = nil) -> String {
        String(format: text(key, bundle: bundle, locale: locale), locale: locale ?? .autoupdatingCurrent, argument)
    }
}
