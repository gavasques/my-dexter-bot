#if os(iOS)
import AppIntents
import DexterNativeActions

struct DexterIOSIntentsPackage: AppIntentsPackage {
    static var includedPackages: [any AppIntentsPackage.Type] { [DexterNativeActionsPackage.self] }
}

/// No personal entity enumeration or host query occurs in the system shortcut process.
struct ChooseDexterConversationIntent: AppIntent {
    static var title: LocalizedStringResource { "Choose a conversation" }
    static var description: IntentDescription { "Open Dexter and select a conversation yourself. No message is sent." }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
    static var parameterSummary: some ParameterSummary { Summary("Choose a conversation in Dexter", table:"Localizable") }
    func perform() async throws -> some IntentResult & ProvidesDialog {
        await MainActor.run { NativeActionSceneRouter.shared.router.requestConversationPicker() }
        return .result(dialog:"Choose a conversation in Dexter. Your host may be offline.")
    }
}
@available(iOS 26.0, *) extension ChooseDexterConversationIntent {
    static var supportedModes: IntentModes { .foreground }
}
@available(iOS, deprecated:26.0, message:"Use supportedModes on iOS 26 and later.")
extension ChooseDexterConversationIntent {
    static let openAppWhenRun = true
}
struct DexterIOSShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent:ChooseDexterConversationIntent(),phrases:["Choose a conversation in \(.applicationName)"],shortTitle:"Choose a conversation",systemImageName:"bubble.left.and.bubble.right")
    }
}
#endif
