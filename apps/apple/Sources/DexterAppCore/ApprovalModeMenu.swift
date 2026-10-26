import DexterHostClient
import Foundation
import SwiftUI

extension BotApprovalPolicyMode {
    public func title(locale: Locale = .current) -> String {
        let pt = locale.language.languageCode?.identifier == "pt"
        switch self {
        case .ask: return pt ? "Supervisionado" : "Supervised"
        case .acceptEdits: return pt ? "Aceitar edições" : "Auto-accept edits"
        case .approveAll: return pt ? "Automático" : "Auto"
        case .fullAccess: return pt ? "Acesso completo" : "Full access"
        }
    }
    public func summary(locale: Locale = .current) -> String {
        let pt = locale.language.languageCode?.identifier == "pt"
        switch self {
        case .ask: return pt ? "Pede aprovação antes de comandos e alterações." : "Ask before commands and file changes."
        case .acceptEdits: return pt ? "Aceita edições permitidas; pergunta antes das outras ações." : "Approve allowed edits; ask before other actions."
        case .approveAll: return pt ? "Aceita edições e rotinas compatíveis; comandos e ações sem suporte pedem aprovação." : "Approve supported edits and routine actions; commands and unsupported actions ask."
        case .fullAccess: return pt ? "Permite comandos, edições e rotinas nos acessos já concedidos." : "Allow commands, edits and routine actions within existing access."
        }
    }
    public var symbol: String {
        switch self { case .ask: "lock"; case .acceptEdits: "pencil"; case .approveAll: "sparkles"; case .fullAccess: "lock.open" }
    }
    public static func boundary(locale: Locale = .current) -> String {
        locale.language.languageCode?.identifier == "pt"
            ? "Vale nas ferramentas do Dexter. Não muda a política do provider, faz login ou concede permissões do computador."
            : "Applies to Dexter tools. It does not change the provider’s policy, sign in or grant computer permissions."
    }
}

public struct ApprovalModeMenu: View {
    @Environment(\.locale) private var locale
    public var mode: BotApprovalPolicyMode
    public var busy: Bool
    public var enabled: Bool
    public var usesBotDefault: Bool
    public var identifier: String
    public var select: (BotApprovalPolicyMode?) -> Void
    public init(mode: BotApprovalPolicyMode, busy: Bool = false, enabled: Bool = true, usesBotDefault: Bool = false,
                identifier: String = "chat.approval-mode", select: @escaping (BotApprovalPolicyMode?) -> Void) {
        self.mode = mode; self.busy = busy; self.enabled = enabled; self.usesBotDefault = usesBotDefault
        self.identifier = identifier; self.select = select
    }
    public var body: some View {
        Menu {
            ForEach(BotApprovalPolicyMode.allCases, id: \.rawValue) { option in
                Button { select(option) } label: {
                    Label(option.title(locale: locale) + "\n" + option.summary(locale: locale),
                          systemImage: option == mode ? "checkmark" : option.symbol)
                }.accessibilityIdentifier("\(identifier).\(option.rawValue)")
            }
            Divider()
            Button(locale.language.languageCode?.identifier == "pt" ? "Usar padrão do bot" : "Use bot default") { select(nil) }
                .accessibilityIdentifier("\(identifier).inherit")
        } label: {
            Label(busy ? (locale.language.languageCode?.identifier == "pt" ? "Salvando…" : "Saving…") : mode.title(locale: locale), systemImage: mode.symbol)
        }
        .disabled(!enabled || busy)
        .help(mode.summary(locale: locale) + " " + Self.scopeCopy(usesBotDefault, locale) + " " + BotApprovalPolicyMode.boundary(locale: locale))
        .accessibilityLabel(mode.title(locale: locale) + ". " + Self.scopeCopy(usesBotDefault, locale))
        .accessibilityIdentifier(identifier)
    }
    private static func scopeCopy(_ inherited: Bool, _ locale: Locale) -> String {
        if locale.language.languageCode?.identifier == "pt" { return inherited ? "Padrão do bot" : "Só esta conversa" }
        return inherited ? "Bot default" : "This conversation only"
    }
}
