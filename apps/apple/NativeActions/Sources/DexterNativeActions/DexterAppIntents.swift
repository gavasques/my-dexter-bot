#if os(iOS)
import AppIntents
import Foundation

@available(iOS 17.0, macOS 14.0, *)
public struct OpenDexterConversationIntent: AppIntent {
    public static var title: LocalizedStringResource { LocalizedStringResource("Open conversation", bundle: .module) }
    public static var description: IntentDescription {
        IntentDescription(LocalizedStringResource("Open a host-issued conversation ID in Dexter. The app checks current host access.", bundle: .module))
    }
    public static let isDiscoverable = true

    @Parameter(
        title: LocalizedStringResource("Conversation ID", bundle: .module),
        description: LocalizedStringResource("A conversation ID issued by your Dexter host; Dexter validates it again.", bundle: .module)
    )
    public var conversationID: String

    public init() {}

    public static var parameterSummary: some ParameterSummary {
        Summary("Open a conversation in Dexter", table: "Localizable")
    }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let route = try NativeActionArgumentParser.parse([
                "action": "open_conversation",
                "threadId": conversationID,
            ])
            try await NativeActionHandoffQueue.shared.enqueue(route)
            return .result(dialog: IntentDialog(LocalizedStringResource("Open Dexter to view this conversation. The host may be offline.", bundle: .module)))
        } catch {
            return .result(dialog: IntentDialog(LocalizedStringResource("This conversation request is invalid or could not be handed to Dexter.", bundle: .module)))
        }
    }
}

@available(iOS 17.0, macOS 14.0, *)
public struct PrepareDexterMessageIntent: AppIntent {
    public static var title: LocalizedStringResource { LocalizedStringResource("Prepare a message", bundle: .module) }
    public static var description: IntentDescription {
        IntentDescription(LocalizedStringResource("Open Dexter with a bounded draft for review. This intent never sends the message.", bundle: .module))
    }
    public static let isDiscoverable = true

    @Parameter(
        title: LocalizedStringResource("Conversation ID", bundle: .module),
        description: LocalizedStringResource("A conversation ID issued by your Dexter host; Dexter validates it again.", bundle: .module)
    )
    public var conversationID: String

    @Parameter(
        title: LocalizedStringResource("Message draft", bundle: .module),
        description: LocalizedStringResource("A draft up to 4,096 UTF-16 code units. Dexter will ask you to review before sending.", bundle: .module)
    )
    public var draft: String

    public init() {}

    public static var parameterSummary: some ParameterSummary {
        Summary("Prepare a draft in Dexter", table: "Localizable")
    }

    public static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

    public func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let route = try NativeActionArgumentParser.parse([
                "action": "prepare_message",
                "threadId": conversationID,
                "draft": draft,
            ])
            try await NativeActionHandoffQueue.shared.enqueue(route)
            return .result(dialog: IntentDialog(LocalizedStringResource("Draft staged in Dexter. Review it in the app; it has not been sent.", bundle: .module)))
        } catch {
            return .result(dialog: IntentDialog(LocalizedStringResource("This draft request is invalid or could not be handed to Dexter.", bundle: .module)))
        }
    }
}

// `supportedModes` was added in iOS/macOS 26. Earlier supported systems use openAppWhenRun.
@available(iOS 26.0, macOS 26.0, *)
extension OpenDexterConversationIntent {
    public static var supportedModes: IntentModes { .foreground }
}

@available(iOS 26.0, macOS 26.0, *)
extension PrepareDexterMessageIntent {
    public static var supportedModes: IntentModes { .foreground }
}

@available(iOS, deprecated: 26.0, message: "Use supportedModes on iOS 26 and later.")
@available(macOS, deprecated: 26.0, message: "Use supportedModes on macOS 26 and later.")
extension OpenDexterConversationIntent {
    public static let openAppWhenRun = true
}

@available(iOS, deprecated: 26.0, message: "Use supportedModes on iOS 26 and later.")
@available(macOS, deprecated: 26.0, message: "Use supportedModes on macOS 26 and later.")
extension PrepareDexterMessageIntent {
    public static let openAppWhenRun = true
}

@available(iOS 17.0, macOS 14.0, *)
public struct DexterAppShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenDexterConversationIntent(),
            phrases: [
                "Open conversation in \(.applicationName)",
            ],
            shortTitle: LocalizedStringResource("Open conversation", bundle: .module),
            systemImageName: "bubble.left.and.bubble.right"
        )
        AppShortcut(
            intent: PrepareDexterMessageIntent(),
            phrases: [
                "Prepare a message in \(.applicationName)",
            ],
            shortTitle: LocalizedStringResource("Prepare a message", bundle: .module),
            systemImageName: "square.and.pencil"
        )
    }
}

#endif
