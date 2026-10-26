import Foundation

/// Groups of the bot settings sidebar, like System Settings. Display only: section raw values stay the stable
/// `bot-profile.tab.<raw>` IDs, and a group never changes routing, drafts, sessions or what a section saves.
public enum BotSettingsSectionGroup: String, CaseIterable, Hashable, Sendable {
    case bot, work, permissions, activity

    /// Exhaustive on purpose: a new section does not compile until it has a group.
    public init(section: BotSettingsSection) {
        switch section {
        case .profile, .memory: self = .bot
        case .model, .skills, .mcp, .browser: self = .work
        case .access, .communication: self = .permissions
        case .routines, .history: self = .activity
        }
    }

    /// The group's sections in their routing order.
    public var sections: [BotSettingsSection] { BotSettingsSection.allCases.filter { Self(section: $0) == self } }

    /// Every section once, in the order the sidebar shows them.
    public static var sidebarOrder: [BotSettingsSection] { allCases.flatMap(\.sections) }
}
