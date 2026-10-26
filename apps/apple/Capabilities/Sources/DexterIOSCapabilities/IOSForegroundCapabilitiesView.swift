#if os(iOS)
import DexterNativeActions
import SwiftUI
import UIKit

@MainActor
private enum IOSForegroundCapabilityRuntime {
    static let provider = IOSForegroundNativeProvider()
    static let boundary = IOSForegroundCapabilityBoundary(backend: provider)
    static let flow = IOSForegroundCapabilityFlowController(boundary: boundary, permissionBackend: provider)
}

/// Standalone local-only screen for a person to choose one narrow foreground operation.
/// It has no callback for host, engine, chat, memory, or persistence integration.
@MainActor
public struct IOSForegroundCapabilitiesView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var flow: IOSForegroundCapabilityFlowController
    @State private var operation: Task<Void, Never>?
    @State private var operationID: UUID?

    public init() {
        _flow = State(initialValue: IOSForegroundCapabilityRuntime.flow)
    }

    public var body: some View {
        Form {
            Section {
                Picker(selection: Binding(get: { flow.selectedCapability }, set: select)) {
                    ForEach(IOSNativeCapability.allCases, id: \.rawValue) { capability in
                        Label {
                            title(for: capability)
                        } icon: {
                            Image(systemName: symbol(for: capability))
                        }.tag(capability)
                    }
                } label: {
                    Text("capability.choose", bundle: .module)
                }
                .accessibilityIdentifier("ios-capability.choose")
                Text(scope(for: flow.selectedCapability), bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ios-capability.scope")
                Label {
                    Text("capability.foreground", bundle: .module)
                } icon: {
                    Image(systemName: "iphone.gen3")
                }
                    .font(.footnote)
                    .accessibilityIdentifier("ios-capability.foreground")
            } header: {
                Text("capability.title", bundle: .module)
            } footer: {
                Text("capability.disclosure", bundle: .module)
            }

            Section {
                Button(action: beginHumanTap) {
                    Label {
                        Text(actionLabel(for: flow.selectedCapability), bundle: .module)
                    } icon: {
                        Image(systemName: symbol(for: flow.selectedCapability))
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .disabled(flow.isBusy || scenePhase != .active)
                .accessibilityHint(Text(scope(for: flow.selectedCapability), bundle: .module))
                .accessibilityIdentifier("ios-capability.run-once")

                if flow.isRunning || flow.isPreparingPermission {
                    Button(role: .cancel, action: cancelOperation) {
                        Label {
                            Text("capability.cancel", bundle: .module)
                        } icon: {
                            Image(systemName: "xmark.circle")
                        }
                    }
                    .accessibilityIdentifier("ios-capability.cancel")
                }
                Text(LocalizedStringKey(flow.status.localizationKey), bundle: .module)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("ios-capability.status")
            }

            if let result = flow.result {
                Section {
                    resultView(result.localPresentation)
                } header: {
                    Label {
                        Text("capability.result", bundle: .module)
                    } icon: {
                        Image(systemName: "checkmark.circle")
                    }
                } footer: {
                    Text("capability.local-result", bundle: .module)
                }
                .accessibilityIdentifier("ios-capability.result")
            }
        }
        .navigationTitle(Text("capability.title", bundle: .module))
        .task {
            await flow.viewAppeared(in: capabilityPhase(scenePhase))
        }
        .onChange(of: scenePhase) { _, phase in
            let nextPhase = capabilityPhase(phase)
            if flow.isRunning && (nextPhase == .background || nextPhase == .inactive) {
                operation?.cancel()
            }
            Task { await flow.sceneDidChange(to: nextPhase) }
        }
        .onDisappear {
            if flow.isRunning { operation?.cancel() }
            Task { await flow.viewDisappeared() }
        }
    }

    private func beginHumanTap() {
        guard scenePhase == .active, !flow.isBusy else { return }
        let newID = UUID()
        operationID = newID
        operation = Task {
            _ = try? await flow.humanTapped()
            if operationID == newID {
                operation = nil
                operationID = nil
            }
        }
    }

    private func select(_ capability: IOSNativeCapability) {
        guard capability != flow.selectedCapability else { return }
        if flow.isRunning {
            operation?.cancel()
        }
        Task { await flow.select(capability) }
    }

    private func cancelOperation() {
        if flow.isRunning { operation?.cancel() }
        Task { await flow.cancel() }
    }

    private func capabilityPhase(_ phase: ScenePhase) -> IOSForegroundCapabilityScenePhase {
        switch phase {
        case .active: .active
        case .inactive: .inactive
        case .background: .background
        @unknown default: .inactive
        }
    }

    private func title(for capability: IOSNativeCapability) -> Text {
        switch capability {
        case .calendar: Text("capability.calendar", bundle: .module)
        case .contacts: Text("capability.contacts", bundle: .module)
        case .location: Text("capability.location", bundle: .module)
        case .files: Text("capability.files", bundle: .module)
        case .photos: Text("capability.photos", bundle: .module)
        case .camera: Text("capability.camera", bundle: .module)
        case .microphone: Text("capability.microphone", bundle: .module)
        }
    }

    private func symbol(for capability: IOSNativeCapability) -> String {
        switch capability {
        case .calendar: "calendar"
        case .contacts: "person.crop.circle"
        case .location: "location"
        case .files: "doc.text"
        case .photos: "photo"
        case .camera: "camera"
        case .microphone: "mic"
        }
    }

    private func scope(for capability: IOSNativeCapability) -> LocalizedStringKey {
        switch capability {
        case .calendar: "capability.scope.calendar"
        case .contacts: "capability.scope.contacts"
        case .location: "capability.scope.location"
        case .files: "capability.scope.files"
        case .photos: "capability.scope.photos"
        case .camera: "capability.scope.camera"
        case .microphone: "capability.scope.microphone"
        }
    }

    private func runLabel(for capability: IOSNativeCapability) -> LocalizedStringKey {
        capability == .microphone ? "capability.record-once" : "capability.run-once"
    }

    private func actionLabel(for capability: IOSNativeCapability) -> LocalizedStringKey {
        flow.needsPermissionPreparation ? "capability.prepare-permission" : runLabel(for: capability)
    }

    @ViewBuilder
    private func resultView(_ presentation: IOSForegroundCapabilityPresentation) -> some View {
        switch presentation {
        case .calendar(let events):
            if events.isEmpty { Text("capability.empty", bundle: .module) }
            ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                VStack(alignment: .leading) {
                    Text(event.title)
                    Text(event.start.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        case .contact(let name):
            Label(name, systemImage: "person.crop.circle")
        case .location(let latitude, let longitude):
            Label(String(format: "%.2f, %.2f", latitude, longitude), systemImage: "location")
        case .file(let name, let byteCount, let textPreview):
            Text(name)
            Text(String(format: NSLocalizedString("capability.file-size", bundle: .module, comment: ""), byteCount))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let textPreview, !textPreview.isEmpty {
                Text(textPreview).textSelection(.enabled).font(.system(.body, design: .monospaced))
            }
        case .photo(let jpeg), .cameraImage(let jpeg):
            if let image = UIImage(data: jpeg) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 300)
                    .accessibilityLabel(Text("capability.image-result", bundle: .module))
            }
        case .microphone(let duration, let sampleRate):
            Label(String(format: NSLocalizedString("capability.audio-result", bundle: .module, comment: ""), duration, sampleRate), systemImage: "waveform")
        }
    }
}
#endif
