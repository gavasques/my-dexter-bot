import Foundation
import Observation

/// Panes of the native Settings window, everyday first. Raw values are the stable `settings.tab.<raw>` IDs.
/// `general`, `mac` and `advanced` keep their IDs; `assistants` and `connections` replace `models` and `integrations`.
public enum DexterSettingsTab: String, CaseIterable, Hashable, Sendable {
    case general, assistants, connections, mac, advanced

    /// Pre-five-pane routes. Never listed as panes; they resolve to the pane that now hosts the same controls.
    public static let models: DexterSettingsTab = .assistants
    public static let integrations: DexterSettingsTab = .connections
    /// "Dispositivos" became part of "Este Mac".
    public static let devices: DexterSettingsTab = .mac
    public static let legacyRoutes: [String: DexterSettingsTab] = ["models": .assistants, "integrations": .connections, "devices": .mac]

    /// Accepts current and pre-five-pane raw values (`settings.tab.<raw>` and guide routes); nil for anything else.
    public init?(route raw: String) {
        if let current = DexterSettingsTab(rawValue: raw) { self = current }
        else if let legacy = Self.legacyRoutes[raw] { self = legacy }
        else { return nil }
    }

    /// First-party guide page for the pane (`packages/context`, composed by Root).
    public var guidePageID: String {
        switch self {
        case .general: "settings-general"
        case .assistants: "settings-assistants"
        case .connections: "settings-connections"
        case .mac: "settings-this-mac"
        case .advanced: "settings-advanced"
        }
    }
}

/// Development-only surfaces (demo fixture, host address editor). Never in a Release build, and never in the
/// packaged bundle a user installs, whatever its build configuration: swapping the owner's bots for demo data is
/// a developer tool, not a setting.
public enum DexterDevelopmentTools {
    public static var isCompiledIn: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    public static func isAvailable(packagedLocalHost: Bool) -> Bool { isCompiledIn && !packagedLocalHost }
}

/// Sections of one bot's settings window, in sidebar order. Raw values are the stable `bot-profile.tab.<raw>` IDs.
public enum BotSettingsSection: String, CaseIterable, Hashable, Sendable {
    case profile, model, memory, skills, mcp, access, communication, browser, routines, history
}

/// What the bot settings window shows. A new `id` recreates its editors; drafts never move between targets.
public struct BotSettingsTarget: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let botID: String
    public let hostScope: UUID
    public let hostAddress: String
    public let section: BotSettingsSection
    /// Fail closed: a target taken on another base (or a connection that changed) never mounts an editor here.
    public func matches(hostScope: UUID, hostAddress: String) -> Bool { self.hostScope == hostScope && self.hostAddress == hostAddress }
}

/// A request for the already visible bot settings editor. It decides about drafts before accepting a switch.
public struct BotSettingsRequest: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case section(BotSettingsSection)
        case switchTo(BotSettingsTarget)
    }
    public let token: UUID
    public let kind: Kind
}

/// `teamID == nil` is a new team; it may recover the pending creation kept by the model.
public struct TeamSettingsTarget: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let teamID: String?
    public let hostScope: UUID
    public let hostAddress: String
    public func matches(hostScope: UUID, hostAddress: String) -> Bool { self.hostScope == hostScope && self.hostAddress == hostAddress }
}

public struct TeamSettingsRequest: Equatable, Sendable {
    public let token: UUID
    public let target: TeamSettingsTarget
}

/// A conversation the bot settings asked the main window to open after the owner decided about drafts.
public struct BotThreadRequest: Equatable, Sendable {
    public let token: UUID
    public let botID: String
    public let threadID: String
    public let hostScope: UUID
    public let hostAddress: String
}

public enum DexterWindowRole: Hashable, Sendable {
    case main, settings, botSettings, teamSettings
}

/// UI-only routing between the main window, Settings and the single bot/team settings windows.
/// It never reads or writes the host, never changes the selected bot/conversation and holds no drafts:
/// one target per window, so editors and global projections (grants, catalog) have a single owner.
@MainActor @Observable
public final class DexterWindowRouter {
    public var settingsTab: DexterSettingsTab = .general
    public private(set) var botTarget: BotSettingsTarget?
    public private(set) var botRequest: BotSettingsRequest?
    public private(set) var botWindowVisible = false
    public private(set) var teamTarget: TeamSettingsTarget?
    public private(set) var teamRequest: TeamSettingsRequest?
    public private(set) var teamWindowVisible = false
    public private(set) var threadRequest: BotThreadRequest?
    /// Settings › Geral › "Mostrar boas-vindas": one main window presents the welcome sheet again.
    public private(set) var welcomeRequest: UUID?
    /// Arquivo › "Conectar a outra base…": one main window presents the sheet (Settings has its own buttons).
    public private(set) var connectOtherBaseRequest: UUID?
    /// Exactly one window presents the shared error alert: the Dexter window that was key last.
    public private(set) var errorPresenter: DexterWindowRole = .main

    public init() {}

    /// Same bot on the same host only changes section; another bot, or the same ID on another base, asks the visible
    /// window to decide first. With an editor mounted it asks about drafts; without one the window root answers.
    public func requestBotSettings(botID: String, section: BotSettingsSection, hostScope: UUID, hostAddress: String) {
        let target = BotSettingsTarget(id: UUID(), botID: botID, hostScope: hostScope, hostAddress: hostAddress, section: section)
        guard botWindowVisible, let current = botTarget else {
            botTarget = target; botRequest = nil
            return
        }
        if current.botID == botID, current.matches(hostScope: hostScope, hostAddress: hostAddress) {
            botRequest = BotSettingsRequest(token: UUID(), kind: .section(section))
        } else {
            botRequest = BotSettingsRequest(token: UUID(), kind: .switchTo(target))
        }
    }

    public func acceptBotSwitch(_ token: UUID) {
        guard let request = botRequest, request.token == token, case .switchTo(let target) = request.kind else { return }
        botTarget = target; botRequest = nil
    }

    public func finishBotRequest(_ token: UUID) {
        if botRequest?.token == token { botRequest = nil }
    }

    public func closeBotSettings(_ id: UUID) {
        guard botTarget?.id == id else { return }
        botTarget = nil; botRequest = nil
    }

    public func botWindowAppeared() { botWindowVisible = true }

    /// Closing the window ends the target: reopening always starts from the canonical host state.
    public func botWindowDisappeared() {
        botWindowVisible = false; botTarget = nil; botRequest = nil
        windowClosed(.botSettings)
    }

    public func requestTeamSettings(teamID: String?, hostScope: UUID, hostAddress: String) {
        let target = TeamSettingsTarget(id: UUID(), teamID: teamID, hostScope: hostScope, hostAddress: hostAddress)
        guard teamWindowVisible, let current = teamTarget else {
            teamTarget = target; teamRequest = nil
            return
        }
        if current.teamID == teamID, current.matches(hostScope: hostScope, hostAddress: hostAddress) {
            teamRequest = nil
        } else {
            teamRequest = TeamSettingsRequest(token: UUID(), target: target)
        }
    }

    public func acceptTeamSwitch(_ token: UUID) {
        guard let request = teamRequest, request.token == token else { return }
        teamTarget = request.target; teamRequest = nil
    }

    public func declineTeamSwitch(_ token: UUID) {
        if teamRequest?.token == token { teamRequest = nil }
    }

    public func closeTeamSettings(_ id: UUID) {
        guard teamTarget?.id == id else { return }
        teamTarget = nil; teamRequest = nil
    }

    public func teamWindowAppeared() { teamWindowVisible = true }

    public func teamWindowDisappeared() {
        teamWindowVisible = false; teamTarget = nil; teamRequest = nil
        windowClosed(.teamSettings)
    }

    public func requestThread(botID: String, threadID: String, hostScope: UUID, hostAddress: String) {
        threadRequest = BotThreadRequest(token: UUID(), botID: botID, threadID: threadID, hostScope: hostScope, hostAddress: hostAddress)
    }

    /// One consumer only, even if more than one main window observes the request.
    public func takeThreadRequest(_ token: UUID) -> BotThreadRequest? {
        guard let request = threadRequest, request.token == token else { return nil }
        threadRequest = nil
        return request
    }

    public func requestWelcome() { welcomeRequest = UUID() }

    /// Only presentation: the sheet itself imports nothing until the user pastes an invitation and continues.
    public func requestConnectOtherBase() {
        connectOtherBaseRequest = UUID()
    }

    /// One consumer only (a main window).
    public func takeConnectOtherBaseRequest(_ token: UUID) -> Bool {
        guard connectOtherBaseRequest == token else { return false }
        connectOtherBaseRequest = nil
        return true
    }

    /// One consumer only, like `takeThreadRequest`.
    public func takeWelcomeRequest(_ token: UUID) -> Bool {
        guard welcomeRequest == token else { return false }
        welcomeRequest = nil
        return true
    }

    public func windowBecameKey(_ role: DexterWindowRole) { errorPresenter = role }

    public func windowClosed(_ role: DexterWindowRole) {
        if errorPresenter == role { errorPresenter = .main }
    }
}
