import DexterAppCore
import SwiftUI
#if os(macOS)
import AppKit
#endif

@main
struct DexterAppleApp: App {
    @State private var model = DexterAppModel()
    #if os(iOS)
    @State private var nativeActions = NativeActionSceneRouter.shared
    #endif
    #if os(macOS)
    @NSApplicationDelegateAdaptor(LocalHostAppDelegate.self) private var appDelegate
    /// UI-only routing shared by every scene; the model, host coordinator and conversation stay single.
    @State private var windowRouter = DexterWindowRouter()
    #endif

    var body: some Scene {
        #if os(macOS)
        WindowGroup(id: DexterMacWindowID.main) {
            rootView
                .environment(model)
                .environment(windowRouter)
        }
        .windowResizability(.contentSize)
        // ⌘N is Nova conversa; another window stays its own item (⌥⌘N).
        .commands { DexterMacCommands(router: windowRouter) }
        #else
        WindowGroup {
            rootView
                .environment(model)
                .environment(nativeActions)
        }
        #endif
        #if os(macOS)
        // One bot and one team at a time: editors and the grant projection keep a single owner.
        Window("Ajustes do bot", id: DexterMacWindowID.botSettings) {
            BotSettingsWindowRoot()
                .environment(model)
                .environment(windowRouter)
        }
        .defaultSize(width: 1000, height: 720)
        .windowResizability(.contentMinSize)
        .commandsRemoved()
        Window("Ajustes do time", id: DexterMacWindowID.teamSettings) {
            TeamSettingsWindowRoot()
                .environment(model)
                .environment(windowRouter)
        }
        .defaultSize(width: 760, height: 700)
        .windowResizability(.contentMinSize)
        .commandsRemoved()
        // Native Settings (⌘,). It reuses the app delegate's coordinator: opening it never starts another host.
        Settings {
            SettingsView(localHost: appDelegate.localHost, macAgent: appDelegate.macAgent)
                .environment(model)
                .environment(windowRouter)
        }
        .windowResizability(.contentSize)
        #endif
    }

    private var rootView: DexterRootView {
        #if os(macOS)
        // The coordinator owns the first refresh; without the explicit per-launch opt-in
        // (scripts/launch-dexter-local.mjs) or packaged metadata (scripts/package-local-desktop.mjs)
        // it is exactly the normal refresh.
        let localHost = appDelegate.localHost
        let model = model
        appDelegate.voiceModel = model
        return DexterRootView(initialRefresh: { await localHost.initialRefresh(model: model, macAgent: appDelegate.macAgent) }, localHost: localHost, macAgent: appDelegate.macAgent)
        #else
        return DexterRootView()
        #endif
    }
}

#if os(macOS)
enum DexterMacWindowID {
    static let main = "dexter.main"
    static let botSettings = "dexter.bot-settings"
    static let teamSettings = "dexter.team-settings"
}

/// What the focused main window offers to the menu bar. DexterRootView publishes it with the same callbacks and
/// gates as ⋯ › Nova conversa and the Conversas button; other windows publish nothing, so the items stay disabled.
struct DexterConversationMenuActions {
    let canCreateConversation: Bool
    let isCreatingConversation: Bool
    let canShowConversations: Bool
    let createConversation: @MainActor () -> Void
    let showConversations: @MainActor () -> Void
}

struct DexterConversationMenuActionsKey: FocusedValueKey {
    typealias Value = DexterConversationMenuActions
}

extension FocusedValues {
    var dexterConversationMenu: DexterConversationMenuActions? {
        get { self[DexterConversationMenuActionsKey.self] }
        set { self[DexterConversationMenuActionsKey.self] = newValue }
    }
}

/// Menu bar carriers for the main window shortcuts. Arquivo › Nova conversa (⌘N) replaces the system New Window,
/// which stays as Arquivo › Nova janela (⌥⌘N, as in Mail); Visualizar › Conversas anteriores (⌘[) as in System Settings.
struct DexterMacCommands: Commands {
    /// Arquivo › Conectar a outra base… only asks a main window to show the sheet (UX-P1-07).
    let router: DexterWindowRouter

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            DexterNewConversationMenuItem()
            DexterNewWindowMenuItem()
            Divider()
            DexterConnectOtherBaseMenuItem(router: router)
        }
        CommandGroup(before: .toolbar) {
            DexterConversationsMenuItem()
            Divider()
        }
    }
}

private struct DexterNewConversationMenuItem: View {
    @FocusedValue(\.dexterConversationMenu) private var actions

    var body: some View {
        Button(LocalizedStringKey(actions?.isCreatingConversation == true ? "Criando conversa…" : "Nova conversa")) {
            actions?.createConversation()
        }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(actions?.canCreateConversation != true)
    }
}

private struct DexterNewWindowMenuItem: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Nova janela") { openWindow(id: DexterMacWindowID.main) }
            .keyboardShortcut("n", modifiers: [.command, .option])
    }
}

private struct DexterConnectOtherBaseMenuItem: View {
    let router: DexterWindowRouter
    @Environment(\.openWindow) private var openWindow
    /// Published only by a focused main window.
    @FocusedValue(\.dexterConversationMenu) private var mainWindow

    var body: some View {
        // The focused main window shows the sheet; with none focused, a new main window opens and picks the request up.
        Button("Conectar a outra base…") {
            router.requestConnectOtherBase()
            if mainWindow == nil { openWindow(id: DexterMacWindowID.main) }
        }
    }
}

private struct DexterConversationsMenuItem: View {
    @FocusedValue(\.dexterConversationMenu) private var actions

    var body: some View {
        Button("Conversas anteriores") { actions?.showConversations() }
            .keyboardShortcut("[", modifiers: .command)
            .disabled(actions?.canShowConversations != true)
    }
}

/// Holds the local host coordinator so quitting requests the owned child's graceful shutdown first.
@MainActor
final class LocalHostAppDelegate: NSObject, NSApplicationDelegate {
    let localHost = LocalHostLaunchCoordinator()
    let macAgent = LocalMacAgentProcess()
    weak var voiceModel: DexterAppModel?

    private var terminationPending = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Decided by child ownership, not presentation state: any owned, not-yet-exited child is stopped first.
        if terminationPending { return .terminateLater }
        guard localHost.ownsLiveChild || macAgent.ownsLiveChild || voiceModel?.liveVoiceController.isSessionActive == true else { return .terminateNow }
        terminationPending = true
        Task { @MainActor in
            await voiceModel?.stopLiveVoiceForTermination()
            // Drain the Mac agent before its owned local host. Neither process is force-killed.
            do { try await macAgent.stop() } catch { macAgent.reportUnconfirmedShutdown() }
            await localHost.stopForTermination()
            let confirmed = !localHost.ownsLiveChild && !macAgent.ownsLiveChild
            if !confirmed {
                localHost.terminationWasCancelled()
                macAgent.reportUnconfirmedShutdown()
            }
            terminationPending = false
            sender.reply(toApplicationShouldTerminate: confirmed)
        }
        return .terminateLater
    }
}
#endif

#if os(macOS)
/// The window that was key last presents the shared error alert, so an error is never hidden behind another window.
struct DexterWindowRoleTracker: ViewModifier {
    let role: DexterWindowRole
    /// Optional so synthetic hosts that predate the router keep running; they simply keep the old single presenter.
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @Environment(\.controlActiveState) private var activeState

    func body(content: Content) -> some View {
        content
            .onAppear { if activeState == .key { router?.windowBecameKey(role) } }
            .onChange(of: activeState) { _, state in if state == .key { router?.windowBecameKey(role) } }
            .onDisappear { router?.windowClosed(role) }
    }
}

/// While a settings window holds drafts or a request in progress, its close button and ⌘W are disabled; the
/// owner decides in the window itself. Fails closed: nothing is saved or discarded by closing.
struct MacWindowCloseGuard: NSViewRepresentable {
    let blocksClose: Bool

    func makeNSView(context: Context) -> GuardView { GuardView() }
    func updateNSView(_ view: GuardView, context: Context) { view.blocksClose = blocksClose }
    /// The editor went away (another target, or the bot vanished): the window can always be closed again.
    static func dismantleNSView(_ view: GuardView, coordinator: ()) { view.blocksClose = false }

    final class GuardView: NSView {
        var blocksClose = false { didSet { apply() } }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        private func apply() {
            guard let window else { return }
            if blocksClose { window.styleMask.remove(.closable) } else { window.styleMask.insert(.closable) }
        }
    }
}

/// Lets a view bring its own window forward without creating a new one.
@MainActor final class MacHostWindowBox {
    weak var window: NSWindow?
}

struct MacHostWindowReader: NSViewRepresentable {
    let box: MacHostWindowBox

    func makeNSView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.box = box
        return view
    }
    func updateNSView(_ view: ReaderView, context: Context) { view.box = box; box.window = view.window ?? box.window }

    final class ReaderView: NSView {
        var box: MacHostWindowBox?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { box?.window = window }
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
#endif
