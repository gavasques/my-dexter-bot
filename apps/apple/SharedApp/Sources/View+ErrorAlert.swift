import SwiftUI
import DexterAppCore

@MainActor
extension View {
    /// `isActive` lets exactly one presenter own the shared error, e.g. a sheet while it is shown.
    func errorAlert(model: DexterAppModel, isActive: Binding<Bool> = .constant(true)) -> some View {
        modifier(DexterErrorAlert(model: model, isActive: isActive))
    }
}

private struct DexterErrorAlert: ViewModifier {
    @Environment(\.locale) private var locale
    let model: DexterAppModel
    let isActive: Binding<Bool>
    func body(content: Content) -> some View {
        content.alert("Dexter", isPresented: Binding(
            get: { isActive.wrappedValue && model.errorMessage != nil },
            set: { if !$0 && isActive.wrappedValue { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { if isActive.wrappedValue { model.errorMessage = nil } }
        } message: {
            Text(DexterLocalization.text(model.errorMessage ?? "", locale: locale))
        }
    }
}
