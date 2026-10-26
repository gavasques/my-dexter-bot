import DexterHostClient
import Foundation
import SwiftUI

/// Mascot builder: live preview, presets, "Aleatório", body/eyes grids, palette plus custom color, finish and motion.
/// It edits only the bound draft; saving belongs to the screen that owns the profile CAS. The "Prévia" chips simulate
/// states on this screen only and are never sent anywhere. No image generation, network or file access happens here.
public struct BotMascotCreatorView: View {
    /// What "Restaurar" returns to: the host's saved recipe (Dexter default when none), or the look the panel opened with.
    public enum RestorePoint: Equatable, Sendable { case saved, opening }

    @Binding private var appearance: BotAvatarAppearance
    private let baseline: BotAvatarAppearance?
    private let restorePoint: RestorePoint
    private let idPrefix: String
    private let previewSize: CGFloat
    @State private var previewActivity: BotMascotActivity = .idle
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.self) private var environment

    /// - Parameters:
    ///   - baseline: the look "Restaurar" returns to (Dexter default when nil); see `restorePoint` for its meaning.
    ///   - idPrefix: accessibility identifier prefix, e.g. `bot-profile.avatar.mascot`.
    public init(appearance: Binding<BotAvatarAppearance>, baseline: BotAvatarAppearance? = nil, restorePoint: RestorePoint = .saved,
                idPrefix: String, previewSize: CGFloat = 104) {
        _appearance = appearance; self.baseline = baseline; self.restorePoint = restorePoint
        self.idPrefix = idPrefix; self.previewSize = previewSize
    }

    private var pt: Bool { locale.language.languageCode?.identifier == "pt" }
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var restoreTarget: BotAvatarAppearance { baseline ?? .dexterDefault }
    private var previewName: String { previewActivity.label(portuguese: pt) }
    private var restoreHelp: String {
        switch restorePoint {
        case .opening: text("Volta ao visual de quando este painel abriu.", "Returns to the look this panel opened with.")
        case .saved where baseline != nil: text("Volta ao mascote salvo.", "Returns to the saved mascot.")
        case .saved: text("Volta ao visual padrão do Dexter.", "Returns to Dexter’s default look.")
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            stage
            quickActions
            section(text("Corpo", "Body")) {
                tileGrid(BotAvatarAppearance.Body.allCases) { body in
                    let name = body.label(portuguese: pt)
                    tile(appearance.with(body: body), selected: appearance.body == body, label: name,
                         spoken: text("Corpo \(name)", "\(name) body"),
                         id: "\(idPrefix).body.\(body.rawValue)") { update(appearance.with(body: body)) }
                }
            }
            section(text("Olhos", "Eyes")) {
                tileGrid(BotAvatarAppearance.Eyes.allCases) { eyes in
                    let name = eyes.label(portuguese: pt)
                    tile(appearance.with(eyes: eyes), selected: appearance.eyes == eyes, label: name,
                         spoken: text("Olhos \(name)", "\(name) eyes"),
                         id: "\(idPrefix).eyes.\(eyes.rawValue)") { update(appearance.with(eyes: eyes)) }
                }
            }
            section(text("Cor", "Color")) { palette }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 20) { finishPicker; motionPicker }
                VStack(alignment: .leading, spacing: 12) { finishPicker; motionPicker }
            }
        }
        .onDisappear { previewActivity = .idle }
    }

    // MARK: Preview

    private var stage: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(RadialGradient(colors: [Color(mascot: appearance.color, opacity: 0.22), Color(mascot: appearance.color, opacity: 0.04)],
                                         center: .center, startRadius: 4, endRadius: previewSize * 1.1))
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08))
                BotMascotView(appearance: appearance, activity: previewActivity, size: previewSize, seed: idPrefix)
            }
            .frame(maxWidth: .infinity)
            .frame(height: previewSize + 24)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(appearance.accessibilityDescription(portuguese: pt))
            .accessibilityValue(text("Prévia: \(previewName)", "Preview: \(previewName)"))
            .accessibilityIdentifier("\(idPrefix).preview")

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(text("Prévia", "Preview")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(text("simulação só nesta tela; na conversa vale o estado real da base",
                          "simulation on this screen only; conversations follow the host’s real state"))
                    .font(.caption).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }
            BotMascotFlowLayout(spacing: 6) {
                ForEach(BotMascotActivity.allCases, id: \.self) { activity in
                    let selected = previewActivity == activity
                    Button { previewActivity = activity } label: {
                        Text(activity.label(portuguese: pt)).font(.caption.weight(selected ? .semibold : .regular))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .foregroundStyle(selected ? Color.white : Color.primary)
                            .background(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.primary.opacity(0.07)), in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                    .accessibilityIdentifier("\(idPrefix).preview-state.\(activity.rawValue)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(text("Prévia de estados", "State preview"))
            .accessibilityIdentifier("\(idPrefix).preview-state")
            if let previewNote {
                Text(previewNote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(idPrefix).preview-note")
            }
        }
    }

    /// Only when the preview cannot move; the real-state rule is already in the "Prévia" line.
    private var previewNote: String? {
        if reduceMotion {
            return text("Reduzir movimento está ativo: o mascote aparece parado e mostra o estado pela expressão.",
                        "Reduce Motion is on: the mascot stays still and shows the state through its expression.")
        }
        if appearance.motion == .none {
            return text("Movimento “Parado”: o mascote não se anima e mostra o estado pela expressão.",
                        "“Still” motion: the mascot does not animate and shows the state through its expression.")
        }
        return nil
    }

    // MARK: Presets, random, reset

    private var quickActions: some View {
        BotMascotFlowLayout(spacing: 8) {
            ForEach(BotMascotPreset.all) { preset in
                let selected = preset.matches(appearance)
                let name = preset.label(portuguese: pt)
                Button { update(preset.applied(to: appearance)) } label: {
                    HStack(spacing: 6) {
                        BotMascotView(appearance: preset.applied(to: appearance), size: 20, animation: .still)
                        Text(name).font(.callout)
                    }
                    .padding(.leading, 6).padding(.trailing, 10).padding(.vertical, 4)
                    .background(selected ? Color.accentColor.opacity(0.16) : Color.primary.opacity(0.06), in: Capsule())
                    .overlay(Capsule().strokeBorder(selected ? Color.accentColor.opacity(0.7) : Color.primary.opacity(0.08)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(text("Modelo \(name)", "\(name) preset"))
                .accessibilityAddTraits(selected ? [.isSelected] : [])
                .accessibilityIdentifier("\(idPrefix).preset.\(preset.id)")
            }
            Button {
                var generator = SystemRandomNumberGenerator()
                update(BotMascotRandomizer.next(after: appearance, using: &generator))
            } label: { Label(text("Aleatório", "Random"), systemImage: "dice") }
                .help(text("Sorteia corpo, olhos, cor e acabamento. Muda só este rascunho e mantém o movimento.",
                           "Picks a random body, eyes, color and finish. Changes only this draft and keeps the motion."))
                .accessibilityIdentifier("\(idPrefix).random")
            Button { update(restoreTarget) } label: { Label(text("Restaurar", "Restore"), systemImage: "arrow.uturn.backward") }
                .disabled(appearance == restoreTarget)
                .help(restoreHelp)
                .accessibilityIdentifier("\(idPrefix).reset")
        }
    }

    // MARK: Grids

    /// Eight options as one row when there is room, otherwise two balanced rows of four (never 7 + 1).
    private func tileGrid<Item: Hashable, Tile: View>(_ items: [Item], @ViewBuilder content: @escaping (Item) -> Tile) -> some View {
        func rows(_ columns: Int) -> some View {
            Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                ForEach(Array(stride(from: 0, to: items.count, by: columns)), id: \.self) { start in
                    GridRow {
                        ForEach(items[start..<min(start + columns, items.count)], id: \.self) { item in
                            content(item).frame(minWidth: 56, maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        return ViewThatFits(in: .horizontal) { rows(items.count); rows((items.count + 1) / 2) }
    }

    private func tile(_ recipe: BotAvatarAppearance, selected: Bool, label: String, spoken: String, id: String,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                BotMascotView(appearance: recipe, size: 34, animation: .still)
                    .frame(width: 44, height: 38)
                Text(label).font(.caption2).lineLimit(1).minimumScaleFactor(0.8)
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
            }
            .padding(.vertical, 4).frame(maxWidth: .infinity)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.035),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.07), lineWidth: selected ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier(id)
    }

    private var palette: some View {
        VStack(alignment: .leading, spacing: 8) {
            BotMascotFlowLayout(spacing: 8) {
                ForEach(BotMascotPalette.swatches) { swatch in
                    let selected = appearance.colorHex == swatch.hex
                    Button { update(appearance.with(colorHex: swatch.hex)) } label: {
                        Circle().fill(Color(mascot: BotMascotColor(hex: swatch.hex) ?? appearance.color))
                            .overlay(Circle().strokeBorder(Color.primary.opacity(0.15)))
                            .frame(width: 24, height: 24)
                            .padding(3)
                            .overlay(Circle().strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 2))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .help(swatch.label(portuguese: pt))
                    .accessibilityLabel(swatch.label(portuguese: pt))
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                    .accessibilityIdentifier("\(idPrefix).color.\(swatch.id)")
                }
            }
            HStack(spacing: 8) {
                ColorPicker(text("Cor personalizada", "Custom color"), selection: customColor, supportsOpacity: false)
                    .accessibilityIdentifier("\(idPrefix).color.custom")
                if BotMascotPalette.swatch(hex: appearance.colorHex) == nil {
                    Text(verbatim: appearance.colorHex).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .accessibilityIdentifier("\(idPrefix).color.custom-value")
                }
            }
        }
    }

    private var customColor: Binding<Color> {
        Binding(get: { Color(mascot: appearance.color) }, set: { color in
            guard let hex = BotMascotColorConversion.hex(from: color, in: environment), hex != appearance.colorHex else { return }
            appearance = appearance.with(colorHex: hex)
        })
    }

    private var finishPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text("Acabamento", "Finish")).font(.subheadline.weight(.semibold))
            Picker(text("Acabamento", "Finish"), selection: Binding(get: { appearance.finish }, set: { update(appearance.with(finish: $0)) })) {
                ForEach(BotAvatarAppearance.Finish.allCases, id: \.self) { Text($0.label(portuguese: pt)).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            .accessibilityIdentifier("\(idPrefix).finish")
        }
    }

    private var motionPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text("Movimento", "Motion")).font(.subheadline.weight(.semibold))
            Picker(text("Movimento", "Motion"), selection: Binding(get: { appearance.motion }, set: { update(appearance.with(motion: $0)) })) {
                ForEach(BotAvatarAppearance.Motion.allCases, id: \.self) { Text($0.label(portuguese: pt)).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize()
            .accessibilityIdentifier("\(idPrefix).motion")
            Text(motionNote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var motionNote: String {
        switch appearance.motion {
        case .none: text("Sempre parado.", "Always still.")
        case .subtle: text("Pisca e respira de leve.", "Blinks and breathes gently.")
        case .lively: text("Mais expressivo em cada estado.", "More expressive in each state.")
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func update(_ recipe: BotAvatarAppearance) {
        guard recipe != appearance else { return }
        if reduceMotion { appearance = recipe } else { withAnimation(.snappy(duration: 0.2)) { appearance = recipe } }
    }
}

/// Compact 26 pt circular close button with Escape (`.cancelAction`), shared by the creator sheets.
public struct BotMascotCloseButton: View {
    private let label: String
    private let help: String
    private let identifier: String
    private let action: () -> Void

    public init(label: String, help: String, identifier: String, action: @escaping () -> Void) {
        self.label = label; self.help = help; self.identifier = identifier; self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                .frame(width: 26, height: 26)
                .background(Color.primary.opacity(0.07), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.cancelAction)
        .help(help)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

/// The creator in a bounded sheet: fixed header with the X (Escape), scrolling content, fixed footer with Concluído.
/// X/Escape calls `onCancel` (the caller restores what it had when the sheet opened); Concluído calls `onDone`
/// (the caller keeps the edits in its own draft). Neither sends anything to the host.
public struct BotMascotCreatorSheet: View {
    @Binding private var appearance: BotAvatarAppearance
    private let title: String
    private let footnote: String
    private let closeHelp: String
    private let baseline: BotAvatarAppearance?
    private let restorePoint: BotMascotCreatorView.RestorePoint
    private let idPrefix: String
    private let closeID: String
    private let doneID: String
    private let onCancel: () -> Void
    private let onDone: () -> Void
    @Environment(\.locale) private var locale

    public init(appearance: Binding<BotAvatarAppearance>, title: String, footnote: String, closeHelp: String,
                baseline: BotAvatarAppearance?, restorePoint: BotMascotCreatorView.RestorePoint, idPrefix: String,
                closeID: String, doneID: String, onCancel: @escaping () -> Void, onDone: @escaping () -> Void) {
        _appearance = appearance; self.title = title; self.footnote = footnote; self.closeHelp = closeHelp
        self.baseline = baseline; self.restorePoint = restorePoint; self.idPrefix = idPrefix
        self.closeID = closeID; self.doneID = doneID; self.onCancel = onCancel; self.onDone = onDone
    }

    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                BotMascotCloseButton(label: text("Fechar sem aplicar", "Close without applying"), help: closeHelp,
                                     identifier: closeID, action: onCancel)
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            Divider()
            ScrollView {
                BotMascotCreatorView(appearance: $appearance, baseline: baseline, restorePoint: restorePoint, idPrefix: idPrefix)
                    .padding(20)
            }
            Divider()
            HStack(alignment: .center, spacing: 12) {
                Text(footnote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button(text("Concluído", "Done"), action: onDone)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier(doneID)
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
        }
        .frame(minWidth: 520, idealWidth: 600, maxWidth: 680, minHeight: 440, idealHeight: 780, maxHeight: 850)
        .interactiveDismissDisabled()
    }
}

/// Color picker values to the recipe's canonical `#RRGGBB` (sRGB, opacity ignored).
public enum BotMascotColorConversion {
    public static func hex(from color: Color, in environment: EnvironmentValues) -> String? {
        let resolved = color.resolve(in: environment)
        guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = resolved.cgColor.converted(to: sRGB, intent: .defaultIntent, options: nil),
              let components = converted.components, components.count >= 3 else { return nil }
        return BotMascotColor(unitRed: Double(components[0]), green: Double(components[1]), blue: Double(components[2])).hex
    }
}

/// Wrapping row for chips and swatches.
struct BotMascotFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [], current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if !current.indices.isEmpty, needed > width {
                rows.append(current); current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
