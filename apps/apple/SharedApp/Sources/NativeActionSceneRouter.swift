#if os(iOS)
import DexterAppCore
import Observation

/// A single app-process router shared by app creation and App Intents, never constructed per view/window.
@Observable @MainActor final class NativeActionSceneRouter {
    static let shared = NativeActionSceneRouter()
    let router = NativeActionRouter()
    private init() {}
}
#endif
